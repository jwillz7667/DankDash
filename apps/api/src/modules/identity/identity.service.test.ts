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
import {
  type Dispensary,
  type DispensariesRepository,
  type DispensaryStaffMember,
  type DispensaryStaffRepository,
  type NewUser,
  type User,
  type UsersRepository,
} from '@dankdash/db';
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

class FakeStaff implements Pick<DispensaryStaffRepository, 'listActiveForUser'> {
  public readonly byUser = new Map<string, DispensaryStaffMember[]>();

  seed(userId: string, ...rows: DispensaryStaffMember[]): void {
    this.byUser.set(userId, [...(this.byUser.get(userId) ?? []), ...rows]);
  }

  listActiveForUser(userId: string): Promise<readonly DispensaryStaffMember[]> {
    return Promise.resolve(this.byUser.get(userId) ?? []);
  }
}

class FakeDispensaries implements Pick<DispensariesRepository, 'findById'> {
  public readonly rows = new Map<string, Dispensary>();

  seed(row: Dispensary): void {
    this.rows.set(row.id, row);
  }

  findById(id: string): Promise<Dispensary | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

interface TestRig {
  readonly service: IdentityService;
  readonly users: FakeUsers;
  readonly persona: FakePersona;
  readonly staff: FakeStaff;
  readonly dispensaries: FakeDispensaries;
}

function makeRig(): TestRig {
  const users = new FakeUsers();
  const persona = new FakePersona();
  const staff = new FakeStaff();
  const dispensaries = new FakeDispensaries();
  const service = new IdentityService(
    users as unknown as UsersRepository,
    persona as unknown as PersonaService,
    staff as unknown as DispensaryStaffRepository,
    dispensaries as unknown as DispensariesRepository,
  );
  return { service, users, persona, staff, dispensaries };
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

function makeStaff(overrides: Partial<DispensaryStaffMember> = {}): DispensaryStaffMember {
  return {
    id: 'staff_test_id',
    dispensaryId: 'disp_test_id',
    userId: 'user_test_id',
    role: 'manager',
    permissions: {},
    invitedAt: new Date('2026-04-01T00:00:00.000Z'),
    invitedBy: null,
    acceptedAt: new Date('2026-04-02T00:00:00.000Z'),
    removedAt: null,
    ...overrides,
  };
}

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  return {
    id: 'disp_test_id',
    legalName: 'North Loop Cannabis LLC',
    dba: 'North Loop',
    licenseNumber: 'MN-CCB-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-12-01',
    licenseExpiresAt: '2027-12-01',
    metrcFacilityId: null,
    metrcApiKeyEnc: null,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 N 1st St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.2683, 44.9842] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.28, 44.97],
          [-93.25, 44.97],
          [-93.25, 45.0],
          [-93.28, 45.0],
          [-93.28, 44.97],
        ],
      ],
    },
    hoursJson: {},
    phone: null,
    email: null,
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    updatedAt: new Date('2025-12-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('IdentityService.listDispensaries', () => {
  it('projects an active accepted membership with dba as displayName', async () => {
    const rig = makeRig();
    const accepted = new Date('2026-04-02T00:00:00.000Z');
    rig.dispensaries.seed(makeDispensary({ id: 'd1', dba: 'North Loop', legalName: 'NL LLC' }));
    rig.staff.seed(
      'u1',
      makeStaff({
        id: 's1',
        dispensaryId: 'd1',
        userId: 'u1',
        role: 'manager',
        acceptedAt: accepted,
      }),
    );

    const res = await rig.service.listDispensaries('u1');

    expect(res).toEqual({
      memberships: [
        {
          id: 'd1',
          displayName: 'North Loop',
          staffRole: 'manager',
          acceptedAt: accepted.toISOString(),
          joinedAt: accepted.toISOString(),
        },
      ],
    });
  });

  it('falls back to legalName when dba is null and exposes a pending invite with null acceptedAt', async () => {
    const rig = makeRig();
    const invited = new Date('2026-04-15T00:00:00.000Z');
    rig.dispensaries.seed(makeDispensary({ id: 'd1', dba: null, legalName: 'Greenway Co' }));
    rig.staff.seed(
      'u1',
      makeStaff({
        id: 's1',
        dispensaryId: 'd1',
        userId: 'u1',
        role: 'budtender',
        invitedAt: invited,
        acceptedAt: null,
      }),
    );

    const res = await rig.service.listDispensaries('u1');

    expect(res.memberships).toHaveLength(1);
    expect(res.memberships[0]?.displayName).toBe('Greenway Co');
    expect(res.memberships[0]?.acceptedAt).toBeNull();
    expect(res.memberships[0]?.joinedAt).toBe(invited.toISOString());
  });

  it('orders memberships by joinedAt ascending so the most tenured floats first', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ id: 'd_new', dba: 'New Store' }));
    rig.dispensaries.seed(makeDispensary({ id: 'd_old', dba: 'Old Store' }));
    rig.staff.seed(
      'u1',
      makeStaff({
        id: 's_new',
        dispensaryId: 'd_new',
        userId: 'u1',
        acceptedAt: new Date('2026-05-10T00:00:00.000Z'),
      }),
      makeStaff({
        id: 's_old',
        dispensaryId: 'd_old',
        userId: 'u1',
        acceptedAt: new Date('2024-01-05T00:00:00.000Z'),
      }),
    );

    const res = await rig.service.listDispensaries('u1');

    expect(res.memberships.map((m) => m.id)).toEqual(['d_old', 'd_new']);
  });

  it('filters out memberships pointing at soft-deleted dispensaries', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(
      makeDispensary({
        id: 'd_gone',
        dba: 'Gone',
        deletedAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    );
    rig.dispensaries.seed(makeDispensary({ id: 'd_live', dba: 'Live' }));
    rig.staff.seed(
      'u1',
      makeStaff({ id: 's1', dispensaryId: 'd_gone', userId: 'u1' }),
      makeStaff({ id: 's2', dispensaryId: 'd_live', userId: 'u1' }),
    );

    const res = await rig.service.listDispensaries('u1');

    expect(res.memberships.map((m) => m.id)).toEqual(['d_live']);
  });

  it('filters out memberships whose dispensary is not in status=active', async () => {
    const rig = makeRig();
    rig.dispensaries.seed(makeDispensary({ id: 'd_onb', dba: 'Onboarding', status: 'onboarding' }));
    rig.dispensaries.seed(makeDispensary({ id: 'd_live', dba: 'Live', status: 'active' }));
    rig.staff.seed(
      'u1',
      makeStaff({ id: 's1', dispensaryId: 'd_onb', userId: 'u1' }),
      makeStaff({ id: 's2', dispensaryId: 'd_live', userId: 'u1' }),
    );

    const res = await rig.service.listDispensaries('u1');

    expect(res.memberships.map((m) => m.id)).toEqual(['d_live']);
  });

  it('returns an empty list when the user has no memberships at all', async () => {
    const rig = makeRig();
    const res = await rig.service.listDispensaries('ghost');
    expect(res).toEqual({ memberships: [] });
  });

  it('skips memberships that reference a dispensary the lookup cannot resolve', async () => {
    const rig = makeRig();
    // No findById row seeded for d_orphan — simulates a foreign-key
    // race the staff repo's filter (removedAt IS NULL) wouldn't catch.
    rig.staff.seed('u1', makeStaff({ id: 's1', dispensaryId: 'd_orphan', userId: 'u1' }));

    const res = await rig.service.listDispensaries('u1');

    expect(res.memberships).toEqual([]);
  });
});
