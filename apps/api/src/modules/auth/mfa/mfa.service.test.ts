/**
 * Unit tests for MfaService.
 *
 * Uses a real EncryptionService (32-byte test key) so we exercise the
 * encrypt → persist → decrypt → verify round-trip end-to-end, plus an
 * in-memory FakeUsers repo so no database is needed. speakeasy.totp() is
 * called with the same fixed time as the service to compute valid codes —
 * if the algorithm ever changes both sides must agree.
 */
import { randomBytes } from 'node:crypto';
import {
  createEncryptionService,
  type EncryptionService,
  type UsersRepository,
  type User,
  type NewUser,
} from '@dankdash/db';
import { AuthError, ConflictError, NotFoundError } from '@dankdash/types';
import speakeasy from 'speakeasy';
import { beforeEach, describe, expect, it } from 'vitest';
import { MfaService } from './mfa.service.js';

const FIXED_NOW = new Date('2026-05-18T12:00:00.000Z');
const FIXED_TIME_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user_test_id',
    email: 'jane@example.com',
    phone: null,
    passwordHash: '$argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Jane',
    lastName: 'Doe',
    dateOfBirth: null,
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

class FakeUsers implements Pick<UsersRepository, 'findById' | 'update'> {
  public readonly rows = new Map<string, User>();

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  update(id: string, patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>): Promise<User | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: User = {
      ...existing,
      ...(patch as Partial<User>),
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

function makeService(): {
  service: MfaService;
  users: FakeUsers;
  encryption: EncryptionService;
} {
  const users = new FakeUsers();
  const encryption = createEncryptionService({ masterKey: new Uint8Array(randomBytes(32)) });
  const service = new MfaService(users as unknown as UsersRepository, encryption, {
    clock: (): Date => FIXED_NOW,
  });
  return { service, users, encryption };
}

function totpAt(secretBase32: string, time = FIXED_TIME_SECONDS): string {
  return speakeasy.totp({
    secret: secretBase32,
    encoding: 'base32',
    time,
  });
}

describe('MfaService.beginEnrollment', () => {
  it('returns a base32 secret and an otpauth URL labelled with issuer + account', async () => {
    const { service, users } = makeService();
    users.rows.set('u1', makeUser({ id: 'u1' }));

    const result = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });

    expect(result.secretBase32).toMatch(/^[A-Z2-7]+=*$/);
    expect(result.otpauthUrl).toContain('otpauth://totp/');
    expect(result.otpauthUrl).toContain('DankDash:jane@example.com');
    expect(result.otpauthUrl).toContain('issuer=DankDash');
    expect(result.otpauthUrl).toContain(`secret=${result.secretBase32}`);
    expect(result.otpauthUrl).toContain('algorithm=SHA1');
    expect(result.otpauthUrl).toContain('digits=6');
    expect(result.otpauthUrl).toContain('period=30');
  });

  it('does NOT persist the secret', async () => {
    const { service, users } = makeService();
    users.rows.set('u1', makeUser({ id: 'u1' }));

    await service.beginEnrollment({ userId: 'u1', accountLabel: 'jane@example.com' });

    const after = users.rows.get('u1');
    expect(after?.mfaEnabled).toBe(false);
    expect(after?.mfaSecretEnc).toBeNull();
  });

  it('throws MFA_ALREADY_ENROLLED when the user already has MFA enabled', async () => {
    const { service, users, encryption } = makeService();
    users.rows.set(
      'u1',
      makeUser({
        id: 'u1',
        mfaEnabled: true,
        mfaSecretEnc: encryption.encryptString('JBSWY3DPEHPK3PXP', 'users.mfa_secret_enc'),
      }),
    );

    try {
      await service.beginEnrollment({ userId: 'u1', accountLabel: 'jane@example.com' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe('MFA_ALREADY_ENROLLED');
    }
  });

  it('throws NotFoundError when the user does not exist', async () => {
    const { service } = makeService();

    await expect(
      service.beginEnrollment({ userId: 'missing', accountLabel: 'x@example.com' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('MfaService.confirmEnrollment', () => {
  let service: MfaService;
  let users: FakeUsers;

  beforeEach(() => {
    ({ service, users } = makeService());
    users.rows.set('u1', makeUser({ id: 'u1' }));
  });

  it('persists an encrypted secret and sets mfaEnabled=true on valid code', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    const code = totpAt(secretBase32);

    await service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: code });

    const row = users.rows.get('u1');
    expect(row?.mfaEnabled).toBe(true);
    expect(row?.mfaSecretEnc).toBeInstanceOf(Uint8Array);
    // The stored value is the AES-GCM envelope, not the secret itself.
    expect(Buffer.from(row?.mfaSecretEnc ?? new Uint8Array()).toString('utf8')).not.toContain(
      secretBase32,
    );
  });

  it('accepts a code with whitespace (paste-from-app ergonomics)', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    const code = totpAt(secretBase32);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    await service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: spaced });

    expect(users.rows.get('u1')?.mfaEnabled).toBe(true);
  });

  it('rejects a non-numeric code without consulting speakeasy', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });

    await expect(
      service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: 'abc123' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a wrong-length code', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });

    await expect(
      service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: '12345' }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
  });

  it('rejects a numerically valid but incorrect code', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    const wrong = totpAt(secretBase32, FIXED_TIME_SECONDS + 10_000); // future window

    await expect(
      service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: wrong }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
  });

  it('throws MFA_ALREADY_ENROLLED if confirm runs twice on a now-enrolled user', async () => {
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    const code = totpAt(secretBase32);
    await service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: code });

    await expect(
      service.confirmEnrollment({ userId: 'u1', secretBase32, currentCode: code }),
    ).rejects.toMatchObject({ code: 'MFA_ALREADY_ENROLLED' });
  });
});

describe('MfaService.verifyCode', () => {
  let service: MfaService;
  let users: FakeUsers;
  let enrolledSecret: string;

  beforeEach(async () => {
    ({ service, users } = makeService());
    users.rows.set('u1', makeUser({ id: 'u1' }));
    const enrollment = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    enrolledSecret = enrollment.secretBase32;
    await service.confirmEnrollment({
      userId: 'u1',
      secretBase32: enrolledSecret,
      currentCode: totpAt(enrolledSecret),
    });
  });

  it('accepts the current code', async () => {
    await expect(
      service.verifyCode({ userId: 'u1', code: totpAt(enrolledSecret) }),
    ).resolves.toBeUndefined();
  });

  it('accepts a code from the previous step (clock-skew window)', async () => {
    const prevStep = totpAt(enrolledSecret, FIXED_TIME_SECONDS - 30);
    await expect(service.verifyCode({ userId: 'u1', code: prevStep })).resolves.toBeUndefined();
  });

  it('accepts a code from the next step (clock-skew window)', async () => {
    const nextStep = totpAt(enrolledSecret, FIXED_TIME_SECONDS + 30);
    await expect(service.verifyCode({ userId: 'u1', code: nextStep })).resolves.toBeUndefined();
  });

  it('rejects a code two steps in the past (outside window)', async () => {
    const old = totpAt(enrolledSecret, FIXED_TIME_SECONDS - 90);
    await expect(service.verifyCode({ userId: 'u1', code: old })).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });
  });

  it('throws MFA_NOT_ENROLLED when user has not set up MFA', async () => {
    users.rows.set('u2', makeUser({ id: 'u2', mfaEnabled: false, mfaSecretEnc: null }));
    await expect(service.verifyCode({ userId: 'u2', code: '123456' })).rejects.toMatchObject({
      code: 'MFA_NOT_ENROLLED',
    });
  });

  it('throws NotFoundError when user does not exist', async () => {
    await expect(service.verifyCode({ userId: 'missing', code: '123456' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('MfaService.disable', () => {
  let service: MfaService;
  let users: FakeUsers;
  let enrolledSecret: string;

  beforeEach(async () => {
    ({ service, users } = makeService());
    users.rows.set('u1', makeUser({ id: 'u1' }));
    const enrollment = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    enrolledSecret = enrollment.secretBase32;
    await service.confirmEnrollment({
      userId: 'u1',
      secretBase32: enrolledSecret,
      currentCode: totpAt(enrolledSecret),
    });
  });

  it('clears mfaSecretEnc and mfaEnabled when given a valid code', async () => {
    await service.disable({ userId: 'u1', currentCode: totpAt(enrolledSecret) });

    const row = users.rows.get('u1');
    expect(row?.mfaEnabled).toBe(false);
    expect(row?.mfaSecretEnc).toBeNull();
  });

  it('refuses to disable when the code is wrong', async () => {
    const wrong = totpAt(enrolledSecret, FIXED_TIME_SECONDS + 10_000);
    await expect(service.disable({ userId: 'u1', currentCode: wrong })).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });

    // Critically: state is unchanged.
    const row = users.rows.get('u1');
    expect(row?.mfaEnabled).toBe(true);
    expect(row?.mfaSecretEnc).not.toBeNull();
  });

  it('throws MFA_NOT_ENROLLED when MFA is not enabled', async () => {
    users.rows.set('u2', makeUser({ id: 'u2', mfaEnabled: false, mfaSecretEnc: null }));
    await expect(service.disable({ userId: 'u2', currentCode: '123456' })).rejects.toMatchObject({
      code: 'MFA_NOT_ENROLLED',
    });
  });
});

describe('MfaService secret confidentiality', () => {
  it('stored secret cannot be decrypted with the wrong AAD context', async () => {
    const { service, users, encryption } = makeService();
    users.rows.set('u1', makeUser({ id: 'u1' }));
    const { secretBase32 } = await service.beginEnrollment({
      userId: 'u1',
      accountLabel: 'jane@example.com',
    });
    await service.confirmEnrollment({
      userId: 'u1',
      secretBase32,
      currentCode: totpAt(secretBase32),
    });

    const stored = users.rows.get('u1')?.mfaSecretEnc;
    expect(stored).toBeDefined();
    expect(() => encryption.decryptString(stored!, 'wrong.context')).toThrow();
  });
});
