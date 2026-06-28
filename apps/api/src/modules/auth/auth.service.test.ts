/**
 * Unit tests for AuthService.
 *
 * AuthService is the orchestration layer; its leaf services (PasswordService,
 * JwtService, RefreshTokenService, MfaService) are tested separately. Here we
 * stub them via lightweight in-memory fakes so each scenario exercises the
 * branching logic (MFA on/off, unique-collision handling, token-rotation
 * shape) without spinning up a database or running real argon2/RSA work.
 *
 * Token expiry timestamps are checked against a fixed clock so the test
 * doesn't have to tolerate floating-point drift between `new Date()` calls.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  createEncryptionService,
  type EncryptionService,
  type NewSession,
  type NewUser,
  type Session,
  type SessionsRepository,
  type User,
  type UsersRepository,
} from '@dankdash/db';
import { AuthError, type ConflictError } from '@dankdash/types';
import speakeasy from 'speakeasy';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt/jwt.service.js';
import { RefreshTokenService } from './jwt/refresh-token.service.js';
import { MfaService } from './mfa/mfa.service.js';
import { PasswordService } from './password/password.service.js';

const FIXED_NOW = new Date('2026-05-18T12:00:00.000Z');
const FIXED_TIME_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);
const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_SECONDS = 2_592_000;

function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user_test_id',
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

class FakeUsers implements Pick<
  UsersRepository,
  'findById' | 'findByEmail' | 'create' | 'update' | 'recordLogin'
> {
  public readonly rows = new Map<string, User>();
  public readonly byEmail = new Map<string, string>();
  public uniqueViolation: 'email' | 'phone' | null = null;
  public lastLoginAt: Date | null = null;

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByEmail(email: string): Promise<User | null> {
    const id = this.byEmail.get(email.toLowerCase());
    return Promise.resolve(id === undefined ? null : (this.rows.get(id) ?? null));
  }

  create(input: Omit<NewUser, 'id'> & { readonly id?: string }): Promise<User> {
    if (this.uniqueViolation !== null) {
      // Mimic node-postgres' DatabaseError shape so AuthService's
      // isUniqueViolation guard catches it.
      const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505' as const,
        constraint: this.uniqueViolation === 'email' ? 'users_email_unique' : 'users_phone_unique',
      });
      return Promise.reject(err);
    }
    const id = input.id ?? `user_${String(this.rows.size + 1)}`;
    const now = new Date('2026-05-18T12:00:00.000Z');
    const row: User = {
      ...makeUser({ id }),
      ...(input as Partial<User>),
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    this.byEmail.set(row.email.toLowerCase(), id);
    return Promise.resolve(row);
  }

  update(id: string, patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>): Promise<User | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: User = { ...existing, ...(patch as Partial<User>), updatedAt: new Date() };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  recordLogin(id: string, at: Date): Promise<void> {
    this.lastLoginAt = at;
    const existing = this.rows.get(id);
    if (existing !== undefined) {
      this.rows.set(id, { ...existing, lastLoginAt: at });
    }
    return Promise.resolve();
  }
}

class FakeSessions implements Pick<
  SessionsRepository,
  'create' | 'findByRefreshTokenHash' | 'rotate' | 'revoke' | 'revokeFamily' | 'revokeAllForUser'
> {
  public readonly rows = new Map<string, Session>();
  public readonly byHash = new Map<string, string>();

  create(input: Omit<NewSession, 'id'> & { readonly id?: string }): Promise<Session> {
    const id = input.id ?? `session_${String(this.rows.size + 1)}`;
    const row: Session = {
      id,
      userId: input.userId,
      familyId: input.familyId,
      refreshTokenHash: input.refreshTokenHash,
      deviceId: input.deviceId ?? null,
      deviceFingerprint: input.deviceFingerprint ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: input.expiresAt,
      rotatedAt: null,
      rotatedTo: null,
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    };
    this.rows.set(id, row);
    this.byHash.set(Buffer.from(input.refreshTokenHash).toString('hex'), id);
    return Promise.resolve(row);
  }

  findByRefreshTokenHash(hash: Uint8Array): Promise<Session | null> {
    const id = this.byHash.get(Buffer.from(hash).toString('hex'));
    return Promise.resolve(id === undefined ? null : (this.rows.get(id) ?? null));
  }

  rotate(input: {
    predecessorId: string;
    successor: Omit<NewSession, 'id'> & { id?: string };
  }): Promise<Session> {
    return this.create(input.successor).then((successor) => {
      const pred = this.rows.get(input.predecessorId);
      if (pred !== undefined) {
        this.rows.set(input.predecessorId, {
          ...pred,
          rotatedAt: new Date(),
          rotatedTo: successor.id,
        });
      }
      return successor;
    });
  }

  revoke(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined) {
      this.rows.set(id, { ...row, revokedAt: new Date() });
    }
    return Promise.resolve();
  }

  revokeFamily(familyId: string): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows.entries()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        this.rows.set(id, { ...row, revokedAt: new Date() });
        count++;
      }
    }
    return Promise.resolve(count);
  }

  revokeAllForUser(userId: string): Promise<void> {
    for (const [id, row] of this.rows.entries()) {
      if (row.userId === userId && row.revokedAt === null) {
        this.rows.set(id, { ...row, revokedAt: new Date() });
      }
    }
    return Promise.resolve();
  }
}

interface TestRig {
  readonly service: AuthService;
  readonly users: FakeUsers;
  readonly sessions: FakeSessions;
  readonly password: PasswordService;
  readonly jwt: JwtService;
  readonly mfa: MfaService;
  readonly encryption: EncryptionService;
}

function makeRig(): TestRig {
  const users = new FakeUsers();
  const sessions = new FakeSessions();
  const encryption = createEncryptionService({ masterKey: new Uint8Array(randomBytes(32)) });
  const password = new PasswordService({
    pepper: 'a'.repeat(32),
    // Use the minimum argon2 memory cost so the unit tests stay snappy.
    // Production wiring uses DEFAULT_HASH_OPTIONS.
    hashOptions: { memoryCost: 8, timeCost: 1, parallelism: 1, hashLength: 32 },
  });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = new JwtService({
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    accessTtlSeconds: ACCESS_TTL_SECONDS,
  });
  const refresh = new RefreshTokenService(sessions as unknown as SessionsRepository, {
    refreshTtlSeconds: REFRESH_TTL_SECONDS,
    clock: (): Date => FIXED_NOW,
  });
  const mfa = new MfaService(users as unknown as UsersRepository, encryption, {
    clock: (): Date => FIXED_NOW,
  });
  const service = new AuthService(
    users as unknown as UsersRepository,
    password,
    jwt,
    refresh,
    mfa,
    { accessTtlSeconds: ACCESS_TTL_SECONDS, clock: (): Date => FIXED_NOW },
  );
  return { service, users, sessions, password, jwt, mfa, encryption };
}

function totpAt(secretBase32: string, time = FIXED_TIME_SECONDS): string {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32', time });
}

describe('AuthService.register', () => {
  it('creates a pending_kyc user, hashes the password, and mints tokens', async () => {
    const { service, users, sessions } = makeRig();

    const result = await service.register({
      email: 'NEW@example.com',
      password: 'sufficient-length-1',
      dateOfBirth: '1990-05-01',
      firstName: 'New',
      lastName: 'User',
    });

    expect(result.user.email).toBe('NEW@example.com'); // service does not lower-case (DTO already does)
    expect(result.user.status).toBe('pending_kyc');
    expect(result.user.kycVerified).toBe(false);
    expect(result.user.mfaEnabled).toBe(false);
    expect(result.tokens.tokenType).toBe('Bearer');
    expect(result.tokens.accessToken.length).toBeGreaterThan(0);
    expect(result.tokens.refreshToken.length).toBeGreaterThan(0);
    expect(result.tokens.accessTokenExpiresAt).toBe(
      new Date(FIXED_NOW.getTime() + ACCESS_TTL_SECONDS * 1000).toISOString(),
    );
    expect(result.tokens.refreshTokenExpiresAt).toBe(
      new Date(FIXED_NOW.getTime() + REFRESH_TTL_SECONDS * 1000).toISOString(),
    );

    const row = users.rows.get(result.user.id);
    expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row?.passwordHash).not.toContain('sufficient-length-1');
    expect(users.lastLoginAt).toEqual(FIXED_NOW);

    // Session row was persisted with the user.
    const session = Array.from(sessions.rows.values())[0];
    expect(session?.userId).toBe(result.user.id);
    expect(session?.familyId).toBe(session?.id); // root of family
  });

  it('translates a unique-constraint violation into an enumeration-safe ConflictError', async () => {
    const { service, users } = makeRig();
    users.uniqueViolation = 'email';

    await expect(
      service.register({
        email: 'taken@example.com',
        password: 'sufficient-length-1',
        dateOfBirth: '1990-05-01',
        firstName: 'A',
        lastName: 'B',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_REGISTERED' });

    // Critically: the response must be identical regardless of which constraint
    // collided — both an email collision and a phone collision yield the same
    // disjunctive "email or phone" message, so an attacker cannot tell which
    // field is registered.
    users.uniqueViolation = 'phone';
    let phoneMessage = '';
    try {
      await service.register({
        email: 'fresh@example.com',
        password: 'sufficient-length-1',
        dateOfBirth: '1990-05-01',
        firstName: 'A',
        lastName: 'B',
      });
    } catch (err) {
      phoneMessage = (err as ConflictError).message;
    }

    users.uniqueViolation = 'email';
    let emailMessage = '';
    try {
      await service.register({
        email: 'taken@example.com',
        password: 'sufficient-length-1',
        dateOfBirth: '1990-05-01',
        firstName: 'A',
        lastName: 'B',
      });
    } catch (err) {
      emailMessage = (err as ConflictError).message;
    }

    expect(phoneMessage).toBe(emailMessage);
    expect(emailMessage).toMatch(/email or phone/i);
  });
});

describe('AuthService.login', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = makeRig();
    await rig.service.register({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      dateOfBirth: '1990-01-01',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  });

  it('returns authenticated + token pair on correct credentials (MFA off)', async () => {
    const result = await rig.service.login({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
    });

    expect(result.status).toBe('authenticated');
    if (result.status === 'authenticated') {
      expect(result.user.email).toBe('jane@example.com');
      expect(result.tokens.tokenType).toBe('Bearer');
    }
  });

  it('rejects wrong password with INVALID_CREDENTIALS', async () => {
    await expect(
      rig.service.login({ email: 'jane@example.com', password: 'wrong-password-123' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('rejects unknown email with INVALID_CREDENTIALS (not a 404)', async () => {
    await expect(
      rig.service.login({ email: 'missing@example.com', password: 'any-password-abc' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('rejects a banned account with INVALID_CREDENTIALS to avoid status leakage', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    rig.users.rows.set(user.id, { ...user, status: 'banned' });

    await expect(
      rig.service.login({ email: 'jane@example.com', password: 'correct-horse-battery-staple' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('returns mfa_required (no tokens) when MFA is on and no code is supplied', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    const enrollment = await rig.mfa.beginEnrollment({ userId: user.id, accountLabel: user.email });
    await rig.mfa.confirmEnrollment({
      userId: user.id,
      secretBase32: enrollment.secretBase32,
      currentCode: totpAt(enrollment.secretBase32),
    });

    const result = await rig.service.login({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
    });

    expect(result.status).toBe('mfa_required');
    if (result.status === 'mfa_required') {
      expect(result.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(result.challengeExpiresAt).getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    }
  });

  it('rejects an invalid MFA code with MFA_CODE_INVALID', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    const enrollment = await rig.mfa.beginEnrollment({ userId: user.id, accountLabel: user.email });
    await rig.mfa.confirmEnrollment({
      userId: user.id,
      secretBase32: enrollment.secretBase32,
      currentCode: totpAt(enrollment.secretBase32),
    });

    await expect(
      rig.service.login({
        email: 'jane@example.com',
        password: 'correct-horse-battery-staple',
        mfaCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
  });

  it('returns authenticated when MFA is on and a valid code is supplied', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    const enrollment = await rig.mfa.beginEnrollment({ userId: user.id, accountLabel: user.email });
    await rig.mfa.confirmEnrollment({
      userId: user.id,
      secretBase32: enrollment.secretBase32,
      currentCode: totpAt(enrollment.secretBase32),
    });

    const result = await rig.service.login({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      mfaCode: totpAt(enrollment.secretBase32),
    });

    expect(result.status).toBe('authenticated');
  });
});

describe('AuthService.refreshTokens', () => {
  let rig: TestRig;
  let initialRefresh: string;

  beforeEach(async () => {
    rig = makeRig();
    const reg = await rig.service.register({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      dateOfBirth: '1990-01-01',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    initialRefresh = reg.tokens.refreshToken;
  });

  it('rotates the refresh token and mints a fresh access token', async () => {
    const result = await rig.service.refreshTokens(initialRefresh);

    expect(result.tokens.refreshToken).not.toBe(initialRefresh);
    expect(result.tokens.accessToken.length).toBeGreaterThan(0);
    expect(result.tokens.tokenType).toBe('Bearer');
  });

  it('cascade-revokes the family when the same refresh token is reused', async () => {
    await rig.service.refreshTokens(initialRefresh);
    // Second use of the same (now rotated) token must trigger family revoke.
    await expect(rig.service.refreshTokens(initialRefresh)).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });

    // Every session in that family should be revoked.
    for (const row of rig.sessions.rows.values()) {
      expect(row.revokedAt).not.toBeNull();
    }
  });

  it('throws TOKEN_REVOKED when the user has been soft-deleted', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    rig.users.rows.set(user.id, { ...user, deletedAt: new Date() });

    await expect(rig.service.refreshTokens(initialRefresh)).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });
  });

  it('throws TOKEN_REVOKED when the user account is suspended', async () => {
    const user = Array.from(rig.users.rows.values())[0];
    assert(user !== undefined, 'seed user missing');
    rig.users.rows.set(user.id, { ...user, status: 'suspended' });

    await expect(rig.service.refreshTokens(initialRefresh)).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });
  });
});

describe('AuthService.logout', () => {
  it('revokes the presented refresh token and is idempotent on unknown tokens', async () => {
    const rig = makeRig();
    const reg = await rig.service.register({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      dateOfBirth: '1990-01-01',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    await rig.service.logout(reg.tokens.refreshToken);

    for (const row of rig.sessions.rows.values()) {
      expect(row.revokedAt).not.toBeNull();
    }

    // Idempotent — logging out an unknown token must not throw.
    await expect(rig.service.logout('a'.repeat(43))).resolves.toBeUndefined();
  });
});

describe('AuthService MFA pass-through', () => {
  it('startMfaEnrollment resolves the user email for the otpauth label', async () => {
    const rig = makeRig();
    const reg = await rig.service.register({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      dateOfBirth: '1990-01-01',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    const setup = await rig.service.startMfaEnrollment(reg.user.id);

    expect(setup.otpauthUrl).toContain('DankDash:jane@example.com');
    expect(setup.secretBase32).toMatch(/^[A-Z2-7]+=*$/);
  });

  it('throws when the user vanishes between auth and MFA setup', async () => {
    const rig = makeRig();
    await expect(rig.service.startMfaEnrollment('ghost')).rejects.toThrow();
  });

  it('verifyMfaCode rejects an invalid code with AuthError', async () => {
    const rig = makeRig();
    const reg = await rig.service.register({
      email: 'jane@example.com',
      password: 'correct-horse-battery-staple',
      dateOfBirth: '1990-01-01',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    const enrollment = await rig.mfa.beginEnrollment({
      userId: reg.user.id,
      accountLabel: reg.user.email,
    });
    await rig.mfa.confirmEnrollment({
      userId: reg.user.id,
      secretBase32: enrollment.secretBase32,
      currentCode: totpAt(enrollment.secretBase32),
    });

    await expect(rig.service.verifyMfaCode(reg.user.id, '000000')).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe('AuthService.issueCheckoutSession', () => {
  it('mints a verifiable access token for a live user (no refresh half)', async () => {
    const rig = makeRig();
    rig.users.rows.set('user_co', makeUser({ id: 'user_co', role: 'customer', status: 'active' }));

    const session = await rig.service.issueCheckoutSession('user_co');

    // A bare session — access token + lifetime + role, no refresh half.
    expect(Object.keys(session).sort()).toEqual(['accessToken', 'expiresInSeconds', 'role']);
    expect(session.role).toBe('customer');
    expect(session.expiresInSeconds).toBe(ACCESS_TTL_SECONDS);
    // The token verifies through the same JwtService the guard uses, carries
    // the user's id + role, and a fresh (unbacked) session id.
    const claims = rig.jwt.verifyAccessToken(session.accessToken);
    expect(claims.sub).toBe('user_co');
    expect(claims.role).toBe('customer');
    expect(claims.sid).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('rejects a hand-off that references a missing user', async () => {
    const rig = makeRig();
    await expect(rig.service.issueCheckoutSession('nope')).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a banned, suspended, or soft-deleted account', async () => {
    const rig = makeRig();
    rig.users.rows.set('u_ban', makeUser({ id: 'u_ban', status: 'banned' }));
    rig.users.rows.set('u_susp', makeUser({ id: 'u_susp', status: 'suspended' }));
    rig.users.rows.set('u_del', makeUser({ id: 'u_del', deletedAt: new Date() }));

    await expect(rig.service.issueCheckoutSession('u_ban')).rejects.toBeInstanceOf(AuthError);
    await expect(rig.service.issueCheckoutSession('u_susp')).rejects.toBeInstanceOf(AuthError);
    await expect(rig.service.issueCheckoutSession('u_del')).rejects.toBeInstanceOf(AuthError);
  });
});
