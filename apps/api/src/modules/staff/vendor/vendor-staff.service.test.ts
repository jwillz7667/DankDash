/**
 * VendorStaffService unit tests.
 *
 * The service composes DispensaryStaffRepository + UsersRepository and
 * enforces three invariants on top of the controller's role gate: caller
 * cannot mutate self, only owners can confer ownership, last owner can
 * neither be demoted nor removed. Each gets a dedicated test.
 *
 * Fakes implement only the methods this service calls — typed against the
 * real interfaces via `as unknown as`. The factory pattern in the service
 * makes this clean: `(_db) => ({ staff, users })` returns the fakes
 * without any container wiring.
 */
import {
  type DispensaryStaffMember,
  type DispensaryStaffRepository,
  type StaffWithUserRow,
  type User,
  type UsersRepository,
} from '@dankdash/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { VendorStaffService } from './vendor-staff.service.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const OWNER_USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const OWNER_STAFF_ID = '01935f3d-0000-7000-8000-0000000000a2';
const MANAGER_USER_ID = '01935f3d-0000-7000-8000-0000000000a3';
const MANAGER_STAFF_ID = '01935f3d-0000-7000-8000-0000000000a4';
const BUDTENDER_USER_ID = '01935f3d-0000-7000-8000-0000000000a5';
const BUDTENDER_STAFF_ID = '01935f3d-0000-7000-8000-0000000000a6';
const INVITEE_USER_ID = '01935f3d-0000-7000-8000-0000000000a7';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d2';

const OWNER_CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: OWNER_USER_ID,
  staffRole: 'owner',
  staffMemberId: OWNER_STAFF_ID,
};

const MANAGER_CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: MANAGER_USER_ID,
  staffRole: 'manager',
  staffMemberId: MANAGER_STAFF_ID,
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: INVITEE_USER_ID,
    email: 'invitee@example.com',
    phone: null,
    passwordHash: 'hash',
    role: 'customer',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Stone',
    dateOfBirth: null,
    kycVerifiedAt: null,
    kycProvider: null,
    kycProviderRef: null,
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeMember(overrides: Partial<DispensaryStaffMember> = {}): DispensaryStaffMember {
  return {
    id: BUDTENDER_STAFF_ID,
    dispensaryId: DISPENSARY_ID,
    userId: BUDTENDER_USER_ID,
    role: 'budtender',
    permissions: {},
    invitedAt: new Date('2026-05-01T00:00:00.000Z'),
    invitedBy: OWNER_USER_ID,
    acceptedAt: new Date('2026-05-01T01:00:00.000Z'),
    removedAt: null,
    ...overrides,
  };
}

function makeRosterRow(overrides: Partial<StaffWithUserRow> = {}): StaffWithUserRow {
  return {
    id: BUDTENDER_STAFF_ID,
    dispensaryId: DISPENSARY_ID,
    userId: BUDTENDER_USER_ID,
    role: 'budtender',
    invitedAt: new Date('2026-05-01T00:00:00.000Z'),
    invitedBy: OWNER_USER_ID,
    acceptedAt: new Date('2026-05-01T01:00:00.000Z'),
    removedAt: null,
    email: 'bud@example.com',
    firstName: 'Bud',
    lastName: 'Tender',
    mfaEnabled: true,
    lastLoginAt: new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  };
}

class FakeStaffRepository {
  public rosterByDispensary = new Map<string, readonly StaffWithUserRow[]>();
  public membersById = new Map<string, DispensaryStaffMember>();
  public membersByDispAndUser = new Map<string, DispensaryStaffMember>();
  public ownerCount = 1;
  public inviteCalls: unknown[] = [];
  public updateRoleCalls: { id: string; role: string }[] = [];
  public removeCalls: { id: string; at: Date }[] = [];

  listWithUserForDispensary = (dispensaryId: string): Promise<readonly StaffWithUserRow[]> => {
    return Promise.resolve(this.rosterByDispensary.get(dispensaryId) ?? []);
  };

  findById = (id: string): Promise<DispensaryStaffMember | null> =>
    Promise.resolve(this.membersById.get(id) ?? null);

  findByDispensaryAndUser = (
    dispensaryId: string,
    userId: string,
  ): Promise<DispensaryStaffMember | null> =>
    Promise.resolve(this.membersByDispAndUser.get(`${dispensaryId}:${userId}`) ?? null);

  countActiveByRole = (_dispensaryId: string, role: string): Promise<number> => {
    return Promise.resolve(role === 'owner' ? this.ownerCount : 0);
  };

  invite = (input: {
    readonly id?: string;
    readonly dispensaryId: string;
    readonly userId: string;
    readonly role: 'budtender' | 'manager' | 'owner';
    readonly invitedBy?: string | null;
    readonly invitedAt?: Date;
    readonly acceptedAt?: Date | null;
    readonly removedAt?: Date | null;
  }): Promise<DispensaryStaffMember> => {
    this.inviteCalls.push(input);
    const member = makeMember({
      id: input.id ?? '01935f3d-0000-7000-8000-0000000000e1',
      dispensaryId: input.dispensaryId,
      userId: input.userId,
      role: input.role,
      invitedAt: input.invitedAt ?? new Date(),
      invitedBy: input.invitedBy ?? null,
      acceptedAt: input.acceptedAt ?? null,
      removedAt: input.removedAt ?? null,
    });
    return Promise.resolve(member);
  };

  updateRole = (
    id: string,
    role: 'budtender' | 'manager' | 'owner',
  ): Promise<DispensaryStaffMember | null> => {
    this.updateRoleCalls.push({ id, role });
    const current = this.membersById.get(id);
    if (current === undefined) return Promise.resolve(null);
    const updated = { ...current, role };
    this.membersById.set(id, updated);
    return Promise.resolve(updated);
  };

  remove = (id: string, at: Date): Promise<void> => {
    this.removeCalls.push({ id, at });
    const current = this.membersById.get(id);
    if (current !== undefined) {
      this.membersById.set(id, { ...current, removedAt: at });
    }
    return Promise.resolve();
  };
}

class FakeUsersRepository {
  public byId = new Map<string, User>();
  public byEmail = new Map<string, User>();

  findById = (id: string): Promise<User | null> => Promise.resolve(this.byId.get(id) ?? null);

  findByEmail = (email: string): Promise<User | null> =>
    Promise.resolve(this.byEmail.get(email) ?? null);
}

function makeService(): {
  service: VendorStaffService;
  staff: FakeStaffRepository;
  users: FakeUsersRepository;
} {
  const staff = new FakeStaffRepository();
  const users = new FakeUsersRepository();
  const service = new VendorStaffService(() => ({
    staff: staff as unknown as DispensaryStaffRepository,
    users: users as unknown as UsersRepository,
  }));
  return { service, staff, users };
}

describe('VendorStaffService.list', () => {
  it('returns the roster joined with users, with Dates mapped to ISO strings', async () => {
    const { service, staff } = makeService();
    staff.rosterByDispensary.set(DISPENSARY_ID, [
      makeRosterRow({ role: 'owner', email: 'owner@example.com', mfaEnabled: true }),
      makeRosterRow({
        id: '01935f3d-0000-7000-8000-0000000000ff',
        role: 'budtender',
        email: 'bud@example.com',
        acceptedAt: null,
        removedAt: null,
      }),
    ]);

    const result = await service.list(OWNER_CTX);

    expect(result.staff).toHaveLength(2);
    expect(result.staff[0]).toMatchObject({
      role: 'owner',
      email: 'owner@example.com',
      mfaEnabled: true,
      invitedAt: '2026-05-01T00:00:00.000Z',
      acceptedAt: '2026-05-01T01:00:00.000Z',
      lastLoginAt: '2026-05-19T12:00:00.000Z',
      removedAt: null,
    });
    expect(result.staff[1]).toMatchObject({
      role: 'budtender',
      acceptedAt: null,
    });
  });

  it('returns empty staff when no members exist', async () => {
    const { service } = makeService();

    const result = await service.list(OWNER_CTX);

    expect(result.staff).toEqual([]);
  });
});

describe('VendorStaffService.invite', () => {
  it('creates a new staff row for an existing user when no prior membership', async () => {
    const { service, staff, users } = makeService();
    const invitee = makeUser({ id: INVITEE_USER_ID, email: 'invitee@example.com' });
    users.byEmail.set('invitee@example.com', invitee);

    const result = await service.invite(OWNER_CTX, {
      email: 'invitee@example.com',
      role: 'manager',
    });

    expect(staff.inviteCalls).toHaveLength(1);
    expect(staff.inviteCalls[0]).toMatchObject({
      dispensaryId: DISPENSARY_ID,
      userId: INVITEE_USER_ID,
      role: 'manager',
      invitedBy: OWNER_USER_ID,
    });
    expect(result.role).toBe('manager');
    expect(result.email).toBe('invitee@example.com');
  });

  it('throws NotFound when no user with that email exists', async () => {
    const { service } = makeService();

    await expect(
      service.invite(OWNER_CTX, { email: 'ghost@example.com', role: 'budtender' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFound when the matching user has been soft-deleted', async () => {
    const { service, users } = makeService();
    users.byEmail.set(
      'deleted@example.com',
      makeUser({ email: 'deleted@example.com', deletedAt: new Date('2026-04-01T00:00:00.000Z') }),
    );

    await expect(
      service.invite(OWNER_CTX, { email: 'deleted@example.com', role: 'budtender' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ValidationError if the caller tries to invite themselves', async () => {
    const { service, users } = makeService();
    users.byEmail.set(
      'owner@example.com',
      makeUser({ id: OWNER_USER_ID, email: 'owner@example.com' }),
    );

    await expect(
      service.invite(OWNER_CTX, { email: 'owner@example.com', role: 'manager' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws Conflict when the user is already an active staff member', async () => {
    const { service, staff, users } = makeService();
    users.byEmail.set(
      'bud@example.com',
      makeUser({ id: BUDTENDER_USER_ID, email: 'bud@example.com' }),
    );
    staff.membersByDispAndUser.set(
      `${DISPENSARY_ID}:${BUDTENDER_USER_ID}`,
      makeMember({ removedAt: null }),
    );

    await expect(
      service.invite(OWNER_CTX, { email: 'bud@example.com', role: 'manager' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('resurrects a previously removed membership instead of inserting a fresh row', async () => {
    const { service, staff, users } = makeService();
    users.byEmail.set(
      'bud@example.com',
      makeUser({ id: BUDTENDER_USER_ID, email: 'bud@example.com' }),
    );
    staff.membersByDispAndUser.set(
      `${DISPENSARY_ID}:${BUDTENDER_USER_ID}`,
      makeMember({
        id: BUDTENDER_STAFF_ID,
        removedAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
    );

    await service.invite(OWNER_CTX, { email: 'bud@example.com', role: 'manager' });

    expect(staff.inviteCalls).toHaveLength(1);
    expect(staff.inviteCalls[0]).toMatchObject({
      id: BUDTENDER_STAFF_ID,
      role: 'manager',
      removedAt: null,
      acceptedAt: null,
    });
  });

  it('forbids a manager from inviting an owner', async () => {
    const { service, users } = makeService();
    users.byEmail.set('invitee@example.com', makeUser({ id: INVITEE_USER_ID }));

    await expect(
      service.invite(MANAGER_CTX, { email: 'invitee@example.com', role: 'owner' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows an owner to invite an owner', async () => {
    const { service, users } = makeService();
    users.byEmail.set('invitee@example.com', makeUser({ id: INVITEE_USER_ID }));

    const result = await service.invite(OWNER_CTX, {
      email: 'invitee@example.com',
      role: 'owner',
    });

    expect(result.role).toBe('owner');
  });
});

describe('VendorStaffService.patchRole', () => {
  it('changes the role on the staff row and returns the hydrated member', async () => {
    const { service, staff, users } = makeService();
    const target = makeMember({ role: 'budtender' });
    staff.membersById.set(BUDTENDER_STAFF_ID, target);
    users.byId.set(
      BUDTENDER_USER_ID,
      makeUser({ id: BUDTENDER_USER_ID, email: 'bud@example.com' }),
    );

    const result = await service.patchRole(OWNER_CTX, BUDTENDER_STAFF_ID, { role: 'manager' });

    expect(staff.updateRoleCalls).toEqual([{ id: BUDTENDER_STAFF_ID, role: 'manager' }]);
    expect(result.role).toBe('manager');
  });

  it('skips the DB write when the role is unchanged (no-op patch)', async () => {
    const { service, staff, users } = makeService();
    const target = makeMember({ role: 'manager' });
    staff.membersById.set(MANAGER_STAFF_ID, target);
    users.byId.set(BUDTENDER_USER_ID, makeUser({ id: BUDTENDER_USER_ID }));

    const result = await service.patchRole(OWNER_CTX, MANAGER_STAFF_ID, { role: 'manager' });

    expect(staff.updateRoleCalls).toEqual([]);
    expect(result.role).toBe('manager');
  });

  it('throws NotFound when the staff row does not exist', async () => {
    const { service } = makeService();

    await expect(
      service.patchRole(OWNER_CTX, BUDTENDER_STAFF_ID, { role: 'manager' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFound (not 403) when the row belongs to another dispensary', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(BUDTENDER_STAFF_ID, makeMember({ dispensaryId: OTHER_DISPENSARY_ID }));

    await expect(
      service.patchRole(OWNER_CTX, BUDTENDER_STAFF_ID, { role: 'manager' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFound when the staff row is removed', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(
      BUDTENDER_STAFF_ID,
      makeMember({ removedAt: new Date('2026-04-01T00:00:00.000Z') }),
    );

    await expect(
      service.patchRole(OWNER_CTX, BUDTENDER_STAFF_ID, { role: 'manager' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ValidationError when the caller tries to change their own role', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(
      OWNER_STAFF_ID,
      makeMember({ id: OWNER_STAFF_ID, userId: OWNER_USER_ID, role: 'owner' }),
    );

    await expect(
      service.patchRole(OWNER_CTX, OWNER_STAFF_ID, { role: 'manager' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('forbids a manager from promoting anyone to owner', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(BUDTENDER_STAFF_ID, makeMember({ role: 'budtender' }));

    await expect(
      service.patchRole(MANAGER_CTX, BUDTENDER_STAFF_ID, { role: 'owner' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses to demote the last active owner', async () => {
    const { service, staff } = makeService();
    const otherOwnerStaffId = '01935f3d-0000-7000-8000-000000000aaa';
    const otherOwnerUserId = '01935f3d-0000-7000-8000-000000000bbb';
    staff.membersById.set(
      otherOwnerStaffId,
      makeMember({ id: otherOwnerStaffId, userId: otherOwnerUserId, role: 'owner' }),
    );
    staff.ownerCount = 1;

    await expect(
      service.patchRole(OWNER_CTX, otherOwnerStaffId, { role: 'manager' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows demoting an owner when more than one owner remains active', async () => {
    const { service, staff, users } = makeService();
    const otherOwnerStaffId = '01935f3d-0000-7000-8000-000000000aaa';
    const otherOwnerUserId = '01935f3d-0000-7000-8000-000000000bbb';
    staff.membersById.set(
      otherOwnerStaffId,
      makeMember({ id: otherOwnerStaffId, userId: otherOwnerUserId, role: 'owner' }),
    );
    users.byId.set(otherOwnerUserId, makeUser({ id: otherOwnerUserId }));
    staff.ownerCount = 2;

    const result = await service.patchRole(OWNER_CTX, otherOwnerStaffId, { role: 'manager' });

    expect(result.role).toBe('manager');
  });
});

describe('VendorStaffService.remove', () => {
  it('soft-removes the staff row with removedAt set to now', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(BUDTENDER_STAFF_ID, makeMember());

    await service.remove(OWNER_CTX, BUDTENDER_STAFF_ID);

    expect(staff.removeCalls).toHaveLength(1);
    expect(staff.removeCalls[0]?.id).toBe(BUDTENDER_STAFF_ID);
    expect(staff.removeCalls[0]?.at).toBeInstanceOf(Date);
  });

  it('throws NotFound when the staff row does not exist', async () => {
    const { service } = makeService();

    await expect(service.remove(OWNER_CTX, BUDTENDER_STAFF_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws NotFound (not 403) when the row belongs to another dispensary', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(BUDTENDER_STAFF_ID, makeMember({ dispensaryId: OTHER_DISPENSARY_ID }));

    await expect(service.remove(OWNER_CTX, BUDTENDER_STAFF_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('throws ValidationError when the caller tries to remove themselves', async () => {
    const { service, staff } = makeService();
    staff.membersById.set(
      OWNER_STAFF_ID,
      makeMember({ id: OWNER_STAFF_ID, userId: OWNER_USER_ID, role: 'owner' }),
    );

    await expect(service.remove(OWNER_CTX, OWNER_STAFF_ID)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to remove the last active owner', async () => {
    const { service, staff } = makeService();
    const otherOwnerStaffId = '01935f3d-0000-7000-8000-000000000aaa';
    const otherOwnerUserId = '01935f3d-0000-7000-8000-000000000bbb';
    staff.membersById.set(
      otherOwnerStaffId,
      makeMember({ id: otherOwnerStaffId, userId: otherOwnerUserId, role: 'owner' }),
    );
    staff.ownerCount = 1;

    await expect(service.remove(OWNER_CTX, otherOwnerStaffId)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('allows removing an owner when more than one owner remains active', async () => {
    const { service, staff } = makeService();
    const otherOwnerStaffId = '01935f3d-0000-7000-8000-000000000aaa';
    const otherOwnerUserId = '01935f3d-0000-7000-8000-000000000bbb';
    staff.membersById.set(
      otherOwnerStaffId,
      makeMember({ id: otherOwnerStaffId, userId: otherOwnerUserId, role: 'owner' }),
    );
    staff.ownerCount = 2;

    await service.remove(OWNER_CTX, otherOwnerStaffId);

    expect(staff.removeCalls).toHaveLength(1);
  });
});
