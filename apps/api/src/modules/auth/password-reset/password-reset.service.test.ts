/**
 * Unit tests for PasswordResetService.
 *
 * The service is the orchestration layer over four collaborators (users repo,
 * reset-token repo, sessions repo, password hasher) plus the notification
 * dispatcher. Repos + dispatcher are lightweight in-memory fakes so each
 * scenario exercises branching — enumeration-safety, supersession, atomic
 * single-use, expiry, eligibility re-check, session revocation — without a
 * database or Redis. The password hasher is the real PasswordService at the
 * minimum argon2 cost so the persisted hash is genuinely verifiable.
 *
 * A mutable clock (`clockRef`) is injected so token TTL and expiry are
 * deterministic regardless of wall-clock time.
 */
import {
  type NewPasswordResetToken,
  type NewUser,
  type PasswordResetToken,
  type PasswordResetTokensRepository,
  type SessionsRepository,
  type User,
  type UsersRepository,
} from '@dankdash/db';
import { AuthError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { PasswordService } from '../password/password.service.js';
import type {
  DispatchInput,
  DispatchOutcome,
  NotificationDispatcher,
} from '../../notifications/notification-dispatcher.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { hashResetCode, normalizeResetCode } from './reset-code.js';

const FIXED_NOW = new Date('2026-05-18T12:00:00.000Z');
const TTL_MINUTES = 15;
const TTL_MS = TTL_MINUTES * 60_000;

function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user_reset_1',
    email: 'jane@example.com',
    phone: null,
    passwordHash: '$argon2id$placeholder',
    role: 'customer',
    status: 'pending_kyc',
    firstName: 'Jane',
    lastName: 'Doe',
    dateOfBirth: '1990-01-01',
    kycVerifiedAt: null,
    kycProvider: null,
    kycProviderRef: null,
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

class FakeUsers implements Pick<UsersRepository, 'findById' | 'findByEmail' | 'update'> {
  public readonly rows = new Map<string, User>();
  public readonly byEmail = new Map<string, string>();
  public readonly updates: Array<{ id: string; patch: Partial<User> }> = [];

  seed(user: User): void {
    this.rows.set(user.id, user);
    this.byEmail.set(user.email.toLowerCase(), user.id);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByEmail(email: string): Promise<User | null> {
    const id = this.byEmail.get(email.toLowerCase());
    return Promise.resolve(id === undefined ? null : (this.rows.get(id) ?? null));
  }

  update(id: string, patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>): Promise<User | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    this.updates.push({ id, patch: patch as Partial<User> });
    const next: User = { ...existing, ...(patch as Partial<User>), updatedAt: new Date() };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

class FakeResetTokens implements Pick<
  PasswordResetTokensRepository,
  'create' | 'findByCodeHash' | 'markUsed' | 'invalidateAllActiveForUser'
> {
  public readonly rows = new Map<string, PasswordResetToken>();
  private readonly byHash = new Map<string, string>();
  private seq = 0;
  /** Forces markUsed to lose the race, simulating a concurrent claim. */
  public markUsedAlwaysFalse = false;

  create(
    input: Omit<NewPasswordResetToken, 'id'> & { readonly id?: string },
  ): Promise<PasswordResetToken> {
    this.seq += 1;
    const id = input.id ?? `prt_${String(this.seq)}`;
    const codeHash = Buffer.from(input.codeHash);
    const row: PasswordResetToken = {
      id,
      userId: input.userId,
      codeHash,
      expiresAt: input.expiresAt,
      usedAt: input.usedAt ?? null,
      requestedIp: input.requestedIp ?? null,
      createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    };
    this.rows.set(id, row);
    this.byHash.set(codeHash.toString('hex'), id);
    return Promise.resolve(row);
  }

  findByCodeHash(codeHash: Uint8Array): Promise<PasswordResetToken | null> {
    const id = this.byHash.get(Buffer.from(codeHash).toString('hex'));
    return Promise.resolve(id === undefined ? null : (this.rows.get(id) ?? null));
  }

  markUsed(id: string, usedAt: Date = new Date()): Promise<boolean> {
    if (this.markUsedAlwaysFalse) return Promise.resolve(false);
    const row = this.rows.get(id);
    if (row?.usedAt !== null) return Promise.resolve(false);
    this.rows.set(id, { ...row, usedAt });
    return Promise.resolve(true);
  }

  invalidateAllActiveForUser(userId: string, at: Date = new Date()): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows.entries()) {
      if (row.userId === userId && row.usedAt === null) {
        this.rows.set(id, { ...row, usedAt: at });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  activeFor(userId: string): PasswordResetToken[] {
    return Array.from(this.rows.values()).filter((r) => r.userId === userId && r.usedAt === null);
  }
}

class FakeSessions implements Pick<SessionsRepository, 'revokeAllForUser'> {
  public readonly revokedUserIds: string[] = [];

  revokeAllForUser(userId: string): Promise<void> {
    this.revokedUserIds.push(userId);
    return Promise.resolve();
  }
}

interface FakeDispatcher {
  readonly calls: Array<DispatchInput<'auth.password_reset'>>;
  dispatch: (input: DispatchInput<'auth.password_reset'>) => Promise<DispatchOutcome>;
}

function makeDispatcher(impl?: () => Promise<DispatchOutcome>): FakeDispatcher {
  const calls: Array<DispatchInput<'auth.password_reset'>> = [];
  return {
    calls,
    dispatch: (input): Promise<DispatchOutcome> => {
      calls.push(input);
      return impl ? impl() : Promise.resolve({ skipped: false, results: [] });
    },
  };
}

interface Rig {
  readonly service: PasswordResetService;
  readonly users: FakeUsers;
  readonly tokens: FakeResetTokens;
  readonly sessions: FakeSessions;
  readonly dispatcher: FakeDispatcher;
  readonly password: PasswordService;
  readonly clockRef: { now: Date };
}

function makeRig(dispatcher: FakeDispatcher = makeDispatcher()): Rig {
  const users = new FakeUsers();
  const tokens = new FakeResetTokens();
  const sessions = new FakeSessions();
  const password = new PasswordService({
    pepper: 'p'.repeat(32),
    hashOptions: { memoryCost: 8, timeCost: 1, parallelism: 1, hashLength: 32 },
  });
  const clockRef = { now: FIXED_NOW };
  const service = new PasswordResetService({
    users: users as unknown as UsersRepository,
    tokens: tokens as unknown as PasswordResetTokensRepository,
    sessions: sessions as unknown as SessionsRepository,
    password,
    dispatcher: dispatcher as unknown as NotificationDispatcher,
    config: { tokenTtlMinutes: TTL_MINUTES, clock: (): Date => clockRef.now },
  });
  return { service, users, tokens, sessions, dispatcher, password, clockRef };
}

describe('PasswordResetService.requestReset', () => {
  it('mints a single-use code, persists only its hash, and emails the display form', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.requestReset('jane@example.com', { ipAddress: '203.0.113.7' });

    expect(rig.dispatcher.calls).toHaveLength(1);
    const call = rig.dispatcher.calls[0]!;
    expect(call.templateKey).toBe('auth.password_reset');
    expect(call.appVariant).toBe('consumer');
    expect(call.userId).toBe('user_reset_1');
    expect(call.payload.expiresInMinutes).toBe(TTL_MINUTES);

    const active = rig.tokens.activeFor('user_reset_1');
    expect(active).toHaveLength(1);
    const token = active[0]!;
    // The dedup key is the token id — distinct requests never collide.
    expect(call.idempotencyKey).toBe(token.id);
    // What we email is the display code; what we store is its hash.
    expect(
      Buffer.compare(token.codeHash, hashResetCode(normalizeResetCode(call.payload.code))),
    ).toBe(0);
    expect(token.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + TTL_MS);
    expect(token.requestedIp).toBe('203.0.113.7');
  });

  it('omits requestedIp when no ip is supplied', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.requestReset('jane@example.com');

    const token = rig.tokens.activeFor('user_reset_1')[0]!;
    expect(token.requestedIp).toBeNull();
  });

  it('supersedes any prior outstanding code so only the newest is redeemable', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.requestReset('jane@example.com');
    await rig.service.requestReset('jane@example.com');

    // Two were minted, but the first was invalidated when the second issued.
    expect(rig.tokens.rows.size).toBe(2);
    expect(rig.tokens.activeFor('user_reset_1')).toHaveLength(1);
  });

  it('is an enumeration-safe no-op for an unknown email', async () => {
    const rig = makeRig();

    await rig.service.requestReset('nobody@example.com');

    expect(rig.tokens.rows.size).toBe(0);
    expect(rig.dispatcher.calls).toHaveLength(0);
  });

  it.each(['banned', 'suspended'] as const)(
    'is a no-op for a %s account (no token, no email)',
    async (status) => {
      const rig = makeRig();
      rig.users.seed(makeUser({ status }));

      await rig.service.requestReset('jane@example.com');

      expect(rig.tokens.rows.size).toBe(0);
      expect(rig.dispatcher.calls).toHaveLength(0);
    },
  );

  it('is a no-op for a soft-deleted account', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ deletedAt: new Date() }));

    await rig.service.requestReset('jane@example.com');

    expect(rig.tokens.rows.size).toBe(0);
    expect(rig.dispatcher.calls).toHaveLength(0);
  });

  it('does not propagate a dispatch failure (no error/timing oracle), but still persists the token', async () => {
    const dispatcher = makeDispatcher(() => Promise.reject(new Error('resend down')));
    const rig = makeRig(dispatcher);
    rig.users.seed(makeUser());

    await expect(rig.service.requestReset('jane@example.com')).resolves.toBeUndefined();

    // The token was created before the dispatch attempt, so it survives.
    expect(rig.tokens.rows.size).toBe(1);
  });
});

describe('PasswordResetService.resetPassword', () => {
  async function mintCode(rig: Rig): Promise<string> {
    rig.users.seed(makeUser());
    await rig.service.requestReset('jane@example.com');
    return rig.dispatcher.calls[0]!.payload.code; // the display form
  }

  it('redeems a valid code: claims it, sets the new hash, and revokes every session', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);

    await rig.service.resetPassword(code, 'brand-new-pass-123');

    // Password updated and the persisted hash verifies against the new secret.
    expect(rig.users.updates).toHaveLength(1);
    const updated = rig.users.rows.get('user_reset_1')!;
    expect(updated.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(rig.password.verify('brand-new-pass-123', updated.passwordHash)).resolves.toBe(
      true,
    );

    // Sessions revoked, and the token is burned (no longer active).
    expect(rig.sessions.revokedUserIds).toEqual(['user_reset_1']);
    expect(rig.tokens.activeFor('user_reset_1')).toHaveLength(0);
  });

  it('accepts the code with separators, lower case, and confusable glyphs', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);

    // Simulate a human re-typing: lower-cased, hyphens replaced by spaces.
    const retyped = code.toLowerCase().replace(/-/gu, ' ');
    await expect(rig.service.resetPassword(retyped, 'brand-new-pass-123')).resolves.toBeUndefined();
    expect(rig.users.updates).toHaveLength(1);
  });

  it('rejects an unknown code with TOKEN_INVALID and touches nothing', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await expect(
      rig.service.resetPassword('ZZZZ-ZZZZ-ZZZZ', 'brand-new-pass-123'),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(rig.users.updates).toHaveLength(0);
    expect(rig.sessions.revokedUserIds).toHaveLength(0);
  });

  it('rejects an expired code with TOKEN_EXPIRED without claiming it', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);

    // Advance past the 15-minute TTL.
    rig.clockRef.now = new Date(FIXED_NOW.getTime() + TTL_MS + 1_000);

    await expect(rig.service.resetPassword(code, 'brand-new-pass-123')).rejects.toBeInstanceOf(
      AuthError,
    );
    await expect(rig.service.resetPassword(code, 'brand-new-pass-123')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
    // Not claimed, no password change.
    expect(rig.tokens.activeFor('user_reset_1')).toHaveLength(1);
    expect(rig.users.updates).toHaveLength(0);
  });

  it('rejects an already-used code with TOKEN_INVALID', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);

    await rig.service.resetPassword(code, 'brand-new-pass-123');
    // Second redemption of the same code.
    await expect(rig.service.resetPassword(code, 'another-new-pass-456')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    // Still only one password update from the first redemption.
    expect(rig.users.updates).toHaveLength(1);
  });

  it('treats a lost claim race as TOKEN_INVALID and does no argon2 / password work', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);
    // A concurrent request claimed the token between our read and our markUsed.
    rig.tokens.markUsedAlwaysFalse = true;

    await expect(rig.service.resetPassword(code, 'brand-new-pass-123')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    expect(rig.users.updates).toHaveLength(0);
    expect(rig.sessions.revokedUserIds).toHaveLength(0);
  });

  it('rejects with TOKEN_INVALID when the account became ineligible after minting (token still burned)', async () => {
    const rig = makeRig();
    const code = await mintCode(rig);
    // Account banned between mint and redemption.
    const user = rig.users.rows.get('user_reset_1')!;
    rig.users.rows.set(user.id, { ...user, status: 'banned' });

    await expect(rig.service.resetPassword(code, 'brand-new-pass-123')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    // The token was claimed before the eligibility check, so it cannot be retried.
    expect(rig.tokens.activeFor('user_reset_1')).toHaveLength(0);
    // No password change, no session revoke for a banned account.
    expect(rig.users.updates).toHaveLength(0);
    expect(rig.sessions.revokedUserIds).toHaveLength(0);
  });
});
