/**
 * Unit tests for IdentityService.
 *
 * The service is a thin orchestration over UsersRepository and PersonaService,
 * so the interesting behaviour to cover is:
 *
 *   - getMe       → projection (kycVerified derived flag, null-safety on
 *                   nullable date columns) and NotFoundError on deleted user.
 *   - updateMe    → narrow patch is the only thing forwarded; deleted-user
 *                   path raises NotFoundError; subsequent getMe sees the
 *                   update.
 *   - startKyc    → persists `kyc_provider_ref` so the webhook can correlate;
 *                   PersonaService failures bubble up unchanged.
 *   - applyKycOutcome → on `kyc.completed`, status flips to 'active', the
 *                   Persona-verified DOB overwrites the user-typed value, and
 *                   non-completed outcomes leave the row untouched.
 *
 * PersonaService is stubbed with a fake whose only job is to return a fixed
 * inquiry shape or reject. We do not exercise its signature-verification path
 * here — that lives in persona.service.test.ts.
 */
import { type NewUser, type User, type UsersRepository } from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from './identity.service.js';
import type { PersonaInquiry, PersonaService, WebhookOutcome } from './persona/persona.service.js';

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
  'findById' | 'create' | 'update' | 'markKycVerified' | 'recordLogin'
> {
  public readonly rows = new Map<string, User>();

  seed(user: User): void {
    this.rows.set(user.id, user);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  create(input: Omit<NewUser, 'id'> & { readonly id?: string }): Promise<User> {
    const id = input.id ?? `user_${String(this.rows.size + 1)}`;
    const row: User = { ...makeUser({ id }), ...(input as Partial<User>), id };
    this.rows.set(id, row);
    return Promise.resolve(row);
  }

  update(id: string, patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>): Promise<User | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: User = { ...existing, ...(patch as Partial<User>), updatedAt: new Date() };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  markKycVerified(id: string, provider: string, providerRef: string): Promise<User | null> {
    return this.update(id, {
      kycVerifiedAt: new Date('2026-05-18T12:00:00.000Z'),
      kycProvider: provider,
      kycProviderRef: providerRef,
      status: 'active',
    });
  }

  recordLogin(_id: string, _at: Date): Promise<void> {
    return Promise.resolve();
  }
}

class FakePersona implements Pick<PersonaService, 'createInquiry'> {
  public lastUserId: string | null = null;
  public nextInquiry: PersonaInquiry = {
    inquiryId: 'inq_abc123',
    hostedFlowUrl: 'https://withpersona.com/verify?inquiry-id=inq_abc123&reference-id=user_test_id',
  };
  public nextError: Error | null = null;

  createInquiry(userId: string): Promise<PersonaInquiry> {
    this.lastUserId = userId;
    if (this.nextError !== null) return Promise.reject(this.nextError);
    return Promise.resolve(this.nextInquiry);
  }
}

interface TestRig {
  readonly service: IdentityService;
  readonly users: FakeUsers;
  readonly persona: FakePersona;
}

function makeRig(): TestRig {
  const users = new FakeUsers();
  const persona = new FakePersona();
  const service = new IdentityService(
    users as unknown as UsersRepository,
    persona as unknown as PersonaService,
  );
  return { service, users, persona };
}

describe('IdentityService.getMe', () => {
  it('projects the user row into MeResponse with derived flags', async () => {
    const rig = makeRig();
    const verifiedAt = new Date('2026-04-01T18:30:00.000Z');
    const lastLogin = new Date('2026-05-18T11:00:00.000Z');
    rig.users.seed(
      makeUser({
        id: 'u1',
        email: 'jane@example.com',
        phone: '+15551234567',
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'customer',
        status: 'active',
        kycVerifiedAt: verifiedAt,
        mfaEnabled: true,
        lastLoginAt: lastLogin,
      }),
    );

    const me = await rig.service.getMe('u1');

    expect(me).toEqual({
      id: 'u1',
      email: 'jane@example.com',
      phone: '+15551234567',
      firstName: 'Jane',
      lastName: 'Doe',
      role: 'customer',
      status: 'active',
      kycVerified: true,
      kycVerifiedAt: verifiedAt.toISOString(),
      mfaEnabled: true,
      lastLoginAt: lastLogin.toISOString(),
      createdAt: makeUser().createdAt.toISOString(),
    });
  });

  it('renders nullable timestamps as null in the projection', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1' }));

    const me = await rig.service.getMe('u1');

    expect(me.kycVerified).toBe(false);
    expect(me.kycVerifiedAt).toBeNull();
    expect(me.lastLoginAt).toBeNull();
  });

  it('throws NotFoundError when the user does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.getMe('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError when the user has been soft-deleted', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1', deletedAt: new Date() }));
    await expect(rig.service.getMe('u1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('IdentityService.updateMe', () => {
  it('applies the firstName/lastName patch and returns the refreshed projection', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1', firstName: 'Old', lastName: 'Name' }));

    const me = await rig.service.updateMe('u1', { firstName: 'NewFirst', lastName: 'NewLast' });

    expect(me.firstName).toBe('NewFirst');
    expect(me.lastName).toBe('NewLast');
    expect(rig.users.rows.get('u1')?.firstName).toBe('NewFirst');
  });

  it('only forwards defined fields — undefined fields do not nullify the column', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1', firstName: 'Original', lastName: 'Unchanged' }));

    const me = await rig.service.updateMe('u1', { firstName: 'Updated' });

    expect(me.firstName).toBe('Updated');
    expect(me.lastName).toBe('Unchanged');
  });

  it('throws NotFoundError when the user does not exist', async () => {
    const rig = makeRig();
    await expect(rig.service.updateMe('ghost', { firstName: 'X' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('IdentityService.startKyc', () => {
  it('creates a Persona inquiry and persists the inquiry id on the user row', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1' }));

    const result = await rig.service.startKyc('u1');

    expect(result).toEqual({
      inquiryId: 'inq_abc123',
      inquiryUrl: rig.persona.nextInquiry.hostedFlowUrl,
    });
    expect(rig.persona.lastUserId).toBe('u1');
    const row = rig.users.rows.get('u1');
    expect(row?.kycProvider).toBe('persona');
    expect(row?.kycProviderRef).toBe('inq_abc123');
  });

  it('throws NotFoundError on a missing user without touching Persona', async () => {
    const rig = makeRig();
    await expect(rig.service.startKyc('ghost')).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.persona.lastUserId).toBeNull();
  });

  it('throws NotFoundError when the user has been soft-deleted', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1', deletedAt: new Date() }));
    await expect(rig.service.startKyc('u1')).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.persona.lastUserId).toBeNull();
  });

  it('propagates Persona errors unchanged', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ id: 'u1' }));
    rig.persona.nextError = new Error('upstream 500');

    await expect(rig.service.startKyc('u1')).rejects.toThrow('upstream 500');
    // The row should not have a kycProviderRef stamped on a failed inquiry.
    expect(rig.users.rows.get('u1')?.kycProviderRef).toBeNull();
  });
});

describe('IdentityService.applyKycOutcome', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = makeRig();
    rig.users.seed(
      makeUser({
        id: 'u1',
        status: 'pending_kyc',
        kycVerifiedAt: null,
        kycProviderRef: 'inq_abc123',
        dateOfBirth: '1990-01-01', // user-typed at registration
      }),
    );
  });

  it('on kyc.completed: flips status=active, stamps verifiedAt, and overwrites DOB with Persona value', async () => {
    const outcome: WebhookOutcome = {
      type: 'kyc.completed',
      userId: 'u1',
      inquiryId: 'inq_abc123',
      dateOfBirth: '1989-06-15', // Persona-verified value differs from user input
    };

    await rig.service.applyKycOutcome(outcome);

    const row = rig.users.rows.get('u1');
    expect(row?.status).toBe('active');
    expect(row?.kycVerifiedAt).not.toBeNull();
    expect(row?.kycProvider).toBe('persona');
    expect(row?.kycProviderRef).toBe('inq_abc123');
    expect(row?.dateOfBirth).toBe('1989-06-15');
  });

  it('on kyc.failed: leaves the user row untouched so they can retry', async () => {
    const before = { ...rig.users.rows.get('u1') };

    await rig.service.applyKycOutcome({
      type: 'kyc.failed',
      userId: 'u1',
      inquiryId: 'inq_abc123',
    });

    const after = rig.users.rows.get('u1');
    expect(after?.status).toBe(before.status);
    expect(after?.kycVerifiedAt).toBeNull();
    expect(after?.dateOfBirth).toBe(before.dateOfBirth);
  });

  it('on kyc.expired: leaves the user row untouched', async () => {
    const before = { ...rig.users.rows.get('u1') };

    await rig.service.applyKycOutcome({
      type: 'kyc.expired',
      userId: 'u1',
      inquiryId: 'inq_abc123',
    });

    const after = rig.users.rows.get('u1');
    expect(after?.status).toBe(before.status);
    expect(after?.kycVerifiedAt).toBeNull();
  });

  it('on ignored events: no DB writes occur', async () => {
    const before = { ...rig.users.rows.get('u1') };

    await rig.service.applyKycOutcome({
      type: 'ignored',
      eventName: 'inquiry.created',
    });

    const after = rig.users.rows.get('u1');
    expect(after?.updatedAt).toEqual(before.updatedAt);
  });
});
