/**
 * Unit tests for RefreshTokenService.
 *
 * The service is exercised against an in-memory fake of `SessionsRepository`
 * — small enough that its behaviour is obvious from reading it, faithful
 * enough that the production CHECK constraint
 * `(rotated_at IS NULL) = (rotated_to IS NULL)` and the single-rotation
 * guarantee (`WHERE rotated_at IS NULL`) are both modelled. Integration
 * tests in `packages/db/test` exercise the real repo against Postgres; here
 * we focus on the service's branching: happy path, four rejection paths,
 * and the OWASP family-burn on reuse.
 */
import { randomUUID } from 'node:crypto';
import {
  type NewSession,
  type RotateSessionInput,
  type Session,
  type SessionsRepository,
} from '@dankdash/db';
import { AuthError, RepositoryError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { RefreshTokenService, hashToken } from './refresh-token.service.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

class FakeSessions {
  readonly rows: Session[] = [];
  readonly calls = {
    revoke: [] as string[],
    revokeFamily: [] as string[],
    revokeAllForUser: [] as string[],
  };

  create = (input: Omit<NewSession, 'id'> & { readonly id?: string }): Promise<Session> => {
    const id = input.id ?? randomUUID();
    const row: Session = {
      id,
      userId: input.userId,
      familyId: input.familyId,
      refreshTokenHash: Buffer.from(input.refreshTokenHash),
      deviceId: input.deviceId ?? null,
      deviceFingerprint: input.deviceFingerprint ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: input.expiresAt,
      rotatedAt: input.rotatedAt ?? null,
      rotatedTo: input.rotatedTo ?? null,
      revokedAt: input.revokedAt ?? null,
      createdAt: input.createdAt ?? new Date(),
      lastUsedAt: input.lastUsedAt ?? new Date(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  };

  findByRefreshTokenHash = (hash: Uint8Array): Promise<Session | null> => {
    const found = this.rows.find((r) => Buffer.compare(r.refreshTokenHash, hash) === 0);
    return Promise.resolve(found ?? null);
  };

  rotate = async (input: RotateSessionInput): Promise<Session> => {
    // Mirrors the real repo's `WHERE rotated_at IS NULL` clause — a
    // predecessor that's already been rotated must fail loudly. Throwing
    // `RepositoryError` matches what the production repo would surface.
    const predecessor = this.rows.find((r) => r.id === input.predecessorId);
    if (predecessor?.rotatedAt !== null) {
      throw new RepositoryError('predecessor session unavailable for rotation', {
        predecessorId: input.predecessorId,
      });
    }
    const successor = await this.create(input.successor);
    predecessor.rotatedAt = new Date();
    predecessor.rotatedTo = successor.id;
    return successor;
  };

  revoke = (id: string): Promise<void> => {
    this.calls.revoke.push(id);
    const row = this.rows.find((r) => r.id === id);
    if (row?.revokedAt === null) {
      row.revokedAt = new Date();
    }
    return Promise.resolve();
  };

  revokeFamily = (familyId: string): Promise<number> => {
    this.calls.revokeFamily.push(familyId);
    let n = 0;
    for (const r of this.rows) {
      if (r.familyId === familyId && r.revokedAt === null) {
        r.revokedAt = new Date();
        n++;
      }
    }
    return Promise.resolve(n);
  };

  revokeAllForUser = (userId: string): Promise<void> => {
    this.calls.revokeAllForUser.push(userId);
    for (const r of this.rows) {
      if (r.userId === userId && r.revokedAt === null) {
        r.revokedAt = new Date();
      }
    }
    return Promise.resolve();
  };
}

function asRepo(fake: FakeSessions): SessionsRepository {
  // The service consumes only the six methods modelled above; the rest of
  // SessionsRepository is irrelevant for refresh-token behaviour. A typed
  // cast keeps tests honest — if the service ever reaches for a new method
  // the suite will throw `fake.X is not a function` immediately.
  return fake as unknown as SessionsRepository;
}

describe('RefreshTokenService', () => {
  let fake: FakeSessions;
  let clock: { now: Date };
  let service: RefreshTokenService;

  beforeEach(() => {
    fake = new FakeSessions();
    clock = { now: new Date('2026-05-18T12:00:00Z') };
    service = new RefreshTokenService(asRepo(fake), {
      refreshTtlSeconds: SEVEN_DAYS_SECONDS,
      clock: () => clock.now,
    });
  });

  describe('issueOnLogin', () => {
    it('creates a session whose id equals its familyId (root of the family)', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      expect(issued.sessionId).toBe(issued.familyId);
      expect(fake.rows).toHaveLength(1);
      const row = fake.rows[0];
      expect(row?.id).toBe(issued.sessionId);
      expect(row?.familyId).toBe(issued.sessionId);
      expect(row?.userId).toBe(USER_ID);
    });

    it('returns a base64url token of the expected length (32 random bytes)', async () => {
      const { rawToken } = await service.issueOnLogin({ userId: USER_ID });
      // 32 bytes → 43 chars base64url, no padding
      expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });

    it('stores the SHA-256 hash of the token, never the raw token itself', async () => {
      const { rawToken } = await service.issueOnLogin({ userId: USER_ID });
      const expectedHash = hashToken(rawToken);
      const stored = fake.rows[0]?.refreshTokenHash;
      expect(stored).toBeDefined();
      expect(stored?.length).toBe(32);
      expect(Buffer.compare(stored!, expectedHash)).toBe(0);
    });

    it('computes expiresAt from the injected clock + ttl', async () => {
      const { expiresAt } = await service.issueOnLogin({ userId: USER_ID });
      expect(expiresAt.getTime()).toBe(clock.now.getTime() + SEVEN_DAYS_SECONDS * 1000);
    });

    it('propagates device, fingerprint, IP, and UA when provided', async () => {
      await service.issueOnLogin({
        userId: USER_ID,
        deviceId: 'iphone-15-pro',
        deviceFingerprint: { os: 'ios', major: 18 },
        ipAddress: '10.0.0.1',
        userAgent: 'DankDash/1.0 (iOS)',
      });
      const row = fake.rows[0];
      expect(row?.deviceId).toBe('iphone-15-pro');
      expect(row?.deviceFingerprint).toEqual({ os: 'ios', major: 18 });
      expect(row?.ipAddress).toBe('10.0.0.1');
      expect(row?.userAgent).toBe('DankDash/1.0 (iOS)');
    });

    it('leaves optional fields null when not provided', async () => {
      await service.issueOnLogin({ userId: USER_ID });
      const row = fake.rows[0];
      expect(row?.deviceId).toBeNull();
      expect(row?.deviceFingerprint).toBeNull();
      expect(row?.ipAddress).toBeNull();
      expect(row?.userAgent).toBeNull();
    });

    it('produces a unique token + session id on every call', async () => {
      const a = await service.issueOnLogin({ userId: USER_ID });
      const b = await service.issueOnLogin({ userId: USER_ID });
      expect(a.rawToken).not.toBe(b.rawToken);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.familyId).not.toBe(b.familyId);
    });
  });

  describe('rotate', () => {
    it('issues a successor in the same family and stamps the predecessor', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      const rotated = await service.rotate({ rawToken: issued.rawToken });

      expect(rotated.familyId).toBe(issued.familyId);
      expect(rotated.sessionId).not.toBe(issued.sessionId);
      expect(rotated.userId).toBe(USER_ID);
      expect(rotated.rawToken).not.toBe(issued.rawToken);

      const predecessor = fake.rows.find((r) => r.id === issued.sessionId);
      expect(predecessor?.rotatedAt).not.toBeNull();
      expect(predecessor?.rotatedTo).toBe(rotated.sessionId);
      expect(predecessor?.revokedAt).toBeNull();

      const successor = fake.rows.find((r) => r.id === rotated.sessionId);
      expect(successor?.rotatedAt).toBeNull();
      expect(successor?.revokedAt).toBeNull();
    });

    it('refreshes expiresAt to clock + ttl on every rotation', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      clock.now = new Date(clock.now.getTime() + 60_000);
      const rotated = await service.rotate({ rawToken: issued.rawToken });
      expect(rotated.expiresAt.getTime()).toBe(clock.now.getTime() + SEVEN_DAYS_SECONDS * 1000);
    });

    it('throws TOKEN_INVALID when the hash is not in the table', async () => {
      try {
        await service.rotate({ rawToken: 'never-issued-by-this-server' });
        expect.unreachable('expected AuthError');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws TOKEN_REVOKED when the session is revoked', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      await service.revoke(issued.rawToken);
      try {
        await service.rotate({ rawToken: issued.rawToken });
        expect.unreachable('expected AuthError');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_REVOKED');
      }
    });

    it('throws TOKEN_EXPIRED when the clock advances past expiresAt', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      clock.now = new Date(issued.expiresAt.getTime() + 1_000);
      try {
        await service.rotate({ rawToken: issued.rawToken });
        expect.unreachable('expected AuthError');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe('TOKEN_EXPIRED');
      }
    });

    it('detects REUSE: replaying the original after rotation burns the family', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      const rotated = await service.rotate({ rawToken: issued.rawToken });

      // Attacker (or buggy client) replays the original token after the
      // legitimate rotation has already happened. The OWASP family pattern
      // says: burn the entire chain — predecessor, successor, everything.
      try {
        await service.rotate({ rawToken: issued.rawToken });
        expect.unreachable('expected AuthError');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        const authErr = err as AuthError;
        expect(authErr.code).toBe('TOKEN_REVOKED');
        expect(authErr.details).toMatchObject({
          reuse_detected: true,
          family_id: issued.familyId,
          revoked_count: 2,
        });
      }

      const familyRows = fake.rows.filter((r) => r.familyId === issued.familyId);
      expect(familyRows).toHaveLength(2);
      for (const r of familyRows) {
        expect(r.revokedAt).not.toBeNull();
      }
      expect(fake.calls.revokeFamily).toEqual([issued.familyId]);

      // The "freshest" token in the chain is now revoked too — the user is
      // forced through a full re-login. This is the whole point.
      try {
        await service.rotate({ rawToken: rotated.rawToken });
        expect.unreachable('expected AuthError');
      } catch (err) {
        expect((err as AuthError).code).toBe('TOKEN_REVOKED');
      }
    });

    it('lets the caller override device fields on rotation', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID, deviceId: 'old-device' });
      const rotated = await service.rotate({
        rawToken: issued.rawToken,
        deviceId: 'new-device',
        ipAddress: '203.0.113.5',
      });
      const successor = fake.rows.find((r) => r.id === rotated.sessionId);
      expect(successor?.deviceId).toBe('new-device');
      expect(successor?.ipAddress).toBe('203.0.113.5');
    });

    it('inherits the predecessor deviceId when the rotate call omits it', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID, deviceId: 'sticky-device' });
      const rotated = await service.rotate({ rawToken: issued.rawToken });
      const successor = fake.rows.find((r) => r.id === rotated.sessionId);
      expect(successor?.deviceId).toBe('sticky-device');
    });

    it('survives multiple sequential rotations within one family', async () => {
      let current = await service.issueOnLogin({ userId: USER_ID });
      const familyId = current.familyId;
      for (let i = 0; i < 5; i++) {
        current = await service.rotate({ rawToken: current.rawToken });
        expect(current.familyId).toBe(familyId);
      }
      const familyRows = fake.rows.filter((r) => r.familyId === familyId);
      expect(familyRows).toHaveLength(6);
      // Exactly one row in the family is the live tail (rotatedAt === null).
      const live = familyRows.filter((r) => r.rotatedAt === null);
      expect(live).toHaveLength(1);
      expect(live[0]?.id).toBe(current.sessionId);
    });
  });

  describe('revoke', () => {
    it('marks the session revoked', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      await service.revoke(issued.rawToken);
      const row = fake.rows.find((r) => r.id === issued.sessionId);
      expect(row?.revokedAt).not.toBeNull();
    });

    it('is silently a no-op for an unknown token (no enumeration oracle)', async () => {
      await expect(service.revoke('this-token-was-never-issued')).resolves.toBeUndefined();
      expect(fake.calls.revoke).toHaveLength(0);
    });

    it('is a no-op when the session is already revoked', async () => {
      const issued = await service.issueOnLogin({ userId: USER_ID });
      await service.revoke(issued.rawToken);
      fake.calls.revoke.length = 0;
      await service.revoke(issued.rawToken);
      expect(fake.calls.revoke).toHaveLength(0);
    });
  });

  describe('revokeAllForUser', () => {
    it('delegates to the repository', async () => {
      await service.revokeAllForUser(USER_ID);
      expect(fake.calls.revokeAllForUser).toEqual([USER_ID]);
    });
  });
});

describe('hashToken', () => {
  it('is deterministic for the same input', () => {
    const a = hashToken('the same input');
    const b = hashToken('the same input');
    expect(Buffer.compare(a, b)).toBe(0);
    expect(a.length).toBe(32);
  });

  it('produces different output for different inputs', () => {
    const a = hashToken('input-a');
    const b = hashToken('input-b');
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});
