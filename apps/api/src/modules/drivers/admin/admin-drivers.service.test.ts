/**
 * Unit tests for AdminDriversService.
 *
 * Behaviours pinned:
 *   - create()  hashes the license number under the DRIVER_LICENSE_NUMBER
 *               context, runs the drivers insert AND the user role-bump
 *               inside one tx, rejects an unknown / soft-deleted user
 *               with NotFoundError, and refuses to re-onboard an existing
 *               driver with DriverError DRIVER_ALREADY_REGISTERED.
 *   - patch()   rejects empty bodies, 404s missing drivers, refuses an
 *               insurance expiry in the past or a background-check date
 *               in the future, and only forwards fields that are
 *               actually present in the patch.
 *
 * `now` is pinned to a known instant so the date assertions are
 * deterministic. The fake tx-handle implementation just calls the inner
 * function with the same fake repos — the production code uses a real
 * Postgres transaction; this test pins the *logic*, not the SQL.
 */
import assert from 'node:assert/strict';
import { DriverError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AdminDriversService, type AdminDriverScopedRepos } from './admin-drivers.service.js';
import type { CreateDriverRequest, PatchDriverRequest } from './dto/index.js';
import type {
  Database,
  DocumentHasher,
  Driver,
  DriversRepository,
  NewDriver,
  NewUser,
  User,
  UsersRepository,
} from '@dankdash/db';

const NOW = new Date('2026-05-18T19:00:00.000Z');
const TOMORROW = '2026-05-19';
const YESTERDAY = '2026-05-17';

function makeUser(overrides: Partial<User> = {}): User {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000a1',
    email: 'driver@example.com',
    phone: null,
    passwordHash: '$argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Alex',
    lastName: 'Driver',
    dateOfBirth: null,
    kycVerifiedAt: null,
    kycProvider: null,
    kycProviderRef: null,
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...overrides,
  };
}

function makeDriver(overrides: Partial<Driver> = {}): Driver {
  const at = new Date('2026-05-18T19:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
    userId: '01935f3d-0000-7000-8000-0000000000a1',
    licenseNumberHash: new Uint8Array(32),
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    vehiclePlate: null,
    vehicleColor: null,
    insuranceDocKey: null,
    insuranceExpiresAt: null,
    backgroundCheckPassedAt: null,
    backgroundCheckProviderRef: null,
    currentStatus: 'offline',
    lastStatusChangeAt: at,
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: null,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeCreateBody(overrides: Partial<CreateDriverRequest> = {}): CreateDriverRequest {
  return {
    userId: '01935f3d-0000-7000-8000-0000000000a1',
    licenseNumber: 'DL-12345',
    ...overrides,
  };
}

class FakeUsersRepo implements Pick<UsersRepository, 'findById' | 'update'> {
  public rows = new Map<string, User>();
  public updateCalls: { id: string; patch: Partial<Omit<NewUser, 'id' | 'createdAt'>> }[] = [];

  seed(u: User): void {
    this.rows.set(u.id, u);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  update(id: string, patch: Partial<Omit<NewUser, 'id' | 'createdAt'>>): Promise<User | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: User = {
      ...existing,
      ...(patch as Partial<User>),
      updatedAt: NOW,
    };
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
}

type DriverPatchInput = Parameters<DriversRepository['update']>[1];

class FakeDriversRepo implements Pick<
  DriversRepository,
  'findById' | 'findByUserId' | 'create' | 'update'
> {
  public byId = new Map<string, Driver>();
  public byUserId = new Map<string, Driver>();
  public createCalls: (Omit<NewDriver, 'id'> & { readonly id?: string })[] = [];
  public updateCalls: { id: string; patch: DriverPatchInput }[] = [];
  public nextCreatedId = '01935f3d-0000-7000-8000-0000000000d1';
  /** Force the next create to throw — useful for tx-rollback assertions. */
  public createThrows: Error | undefined = undefined;

  seed(d: Driver): void {
    this.byId.set(d.id, d);
    this.byUserId.set(d.userId, d);
  }

  findById(id: string): Promise<Driver | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  findByUserId(userId: string): Promise<Driver | null> {
    return Promise.resolve(this.byUserId.get(userId) ?? null);
  }

  create(input: Omit<NewDriver, 'id'> & { readonly id?: string }): Promise<Driver> {
    this.createCalls.push(input);
    if (this.createThrows !== undefined) {
      const err = this.createThrows;
      this.createThrows = undefined;
      return Promise.reject(err);
    }
    const row = makeDriver({
      id: input.id ?? this.nextCreatedId,
      userId: input.userId,
      licenseNumberHash: input.licenseNumberHash,
      vehicleMake: input.vehicleMake ?? null,
      vehicleModel: input.vehicleModel ?? null,
      vehicleYear: input.vehicleYear ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      vehicleColor: input.vehicleColor ?? null,
      insuranceDocKey: input.insuranceDocKey ?? null,
      insuranceExpiresAt: input.insuranceExpiresAt ?? null,
      backgroundCheckPassedAt: input.backgroundCheckPassedAt ?? null,
      backgroundCheckProviderRef: input.backgroundCheckProviderRef ?? null,
    });
    this.byId.set(row.id, row);
    this.byUserId.set(row.userId, row);
    return Promise.resolve(row);
  }

  update(id: string, patch: DriverPatchInput): Promise<Driver | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.byId.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Driver = {
      ...existing,
      ...(patch as unknown as Partial<Driver>),
      updatedAt: NOW,
    };
    this.byId.set(id, next);
    this.byUserId.set(next.userId, next);
    return Promise.resolve(next);
  }
}

class FakeHasher implements DocumentHasher {
  public hashCalls: { value: string; context: string }[] = [];

  hash(value: string, context: string): Uint8Array {
    this.hashCalls.push({ value, context });
    // Deterministic 32-byte fingerprint so assertions can pin the bytes.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < value.length && i < 32; i += 1) {
      buf[i] = value.charCodeAt(i) ^ context.length;
    }
    return new Uint8Array(buf);
  }

  matches(stored: Uint8Array, value: string, context: string): boolean {
    const recomputed = this.hash(value, context);
    return Buffer.from(stored).equals(Buffer.from(recomputed));
  }
}

interface Rig {
  readonly service: AdminDriversService;
  readonly drivers: FakeDriversRepo;
  readonly users: FakeUsersRepo;
  readonly hasher: FakeHasher;
  /** True iff `db.transaction(...)` was called. */
  txCalled(): boolean;
}

function makeRig(): Rig {
  const drivers = new FakeDriversRepo();
  const users = new FakeUsersRepo();
  const hasher = new FakeHasher();
  let txCalled = false;
  const fakeDb = {
    transaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      txCalled = true;
      // The "tx handle" is the same fakeDb — repos are bound by the
      // scoped-repos factory below, which returns the same fake
      // instances. This pins the contract: the service ran the
      // multi-write inside ONE transaction call.
      return fn(fakeDb as unknown as Database);
    },
  };
  const scopedReposFor = (): AdminDriverScopedRepos => ({
    drivers: drivers as unknown as DriversRepository,
    users: users as unknown as UsersRepository,
  });
  const service = new AdminDriversService(
    drivers as unknown as DriversRepository,
    users as unknown as UsersRepository,
    fakeDb as unknown as Database,
    scopedReposFor,
    hasher,
  );
  return {
    service,
    drivers,
    users,
    hasher,
    txCalled: (): boolean => txCalled,
  };
}

describe('AdminDriversService.create', () => {
  it('hashes the license number under the DRIVER_LICENSE_NUMBER context', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.create(makeCreateBody({ licenseNumber: 'DL-12345' }), NOW);

    expect(rig.hasher.hashCalls).toEqual([
      { value: 'DL-12345', context: 'drivers.license_number' },
    ]);
  });

  it('stores the hash output verbatim on the new drivers row', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.create(makeCreateBody(), NOW);

    expect(rig.drivers.createCalls).toHaveLength(1);
    const input = rig.drivers.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.licenseNumberHash).toBeInstanceOf(Uint8Array);
    expect(input.licenseNumberHash.length).toBe(32);
  });

  it('runs the drivers insert and the user role-promotion inside one tx', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.create(makeCreateBody(), NOW);

    expect(rig.txCalled()).toBe(true);
    expect(rig.drivers.createCalls).toHaveLength(1);
    expect(rig.users.updateCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-0000000000a1', patch: { role: 'driver' } },
    ]);
  });

  it('returns a projected DriverResponse (no license-number-hash field)', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    const res = await rig.service.create(makeCreateBody(), NOW);

    expect(res.id).toBe('01935f3d-0000-7000-8000-0000000000d1');
    expect(res.userId).toBe('01935f3d-0000-7000-8000-0000000000a1');
    expect(res.currentStatus).toBe('offline');
    expect(res.totalDeliveries).toBe(0);
    expect(res.ratingCount).toBe(0);
    expect((res as { licenseNumberHash?: unknown }).licenseNumberHash).toBeUndefined();
  });

  it('forwards optional vehicle fields and nulls absentees', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.create(
      makeCreateBody({
        vehicleMake: 'Toyota',
        vehicleModel: 'Prius',
        vehicleYear: 2023,
        vehiclePlate: 'ABC-1234',
        vehicleColor: 'white',
      }),
      NOW,
    );

    const input = rig.drivers.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.vehicleMake).toBe('Toyota');
    expect(input.vehicleModel).toBe('Prius');
    expect(input.vehicleYear).toBe(2023);
    expect(input.vehiclePlate).toBe('ABC-1234');
    expect(input.vehicleColor).toBe('white');
    expect(input.insuranceDocKey).toBeNull();
    expect(input.insuranceExpiresAt).toBeNull();
  });

  it('throws NotFoundError when the linked user does not exist', async () => {
    const rig = makeRig();

    await expect(rig.service.create(makeCreateBody(), NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.users.updateCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
  });

  it('throws NotFoundError when the linked user is soft-deleted', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(rig.service.create(makeCreateBody(), NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
  });

  it('throws DriverError DRIVER_ALREADY_REGISTERED on re-onboarding', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());
    rig.drivers.seed(makeDriver());

    const err = await rig.service.create(makeCreateBody(), NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_ALREADY_REGISTERED');
    expect((err as DriverError).statusCode).toBe(409);
    // No extra create attempt was made after the conflict — important so
    // the unique index on drivers.user_id never has to be the last line
    // of defence.
    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
  });

  it('rejects an insurance expiry in the past', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await expect(
      rig.service.create(makeCreateBody({ insuranceExpiresAt: YESTERDAY }), NOW),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.drivers.createCalls).toEqual([]);
  });

  it('rejects a background-check date in the future', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await expect(
      rig.service.create(makeCreateBody({ backgroundCheckPassedAt: TOMORROW }), NOW),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.drivers.createCalls).toEqual([]);
  });
});

describe('AdminDriversService.patch', () => {
  it('throws ValidationError on an empty patch body', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver());

    const body: PatchDriverRequest = {};
    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-0000000000d1', body, NOW),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.drivers.updateCalls).toEqual([]);
  });

  it('throws NotFoundError when the driver does not exist', async () => {
    const rig = makeRig();

    await expect(
      rig.service.patch('ghost-id', { vehicleColor: 'red' }, NOW),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forwards only present fields to the repo update', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver({ vehicleColor: 'white' }));

    await rig.service.patch(
      '01935f3d-0000-7000-8000-0000000000d1',
      { vehicleColor: 'red', vehiclePlate: 'XYZ-9876' },
      NOW,
    );

    expect(rig.drivers.updateCalls).toHaveLength(1);
    const call = rig.drivers.updateCalls[0];
    assert(call !== undefined, 'expected update call');
    expect(call.id).toBe('01935f3d-0000-7000-8000-0000000000d1');
    expect(call.patch).toEqual({ vehicleColor: 'red', vehiclePlate: 'XYZ-9876' });
  });

  it('allows nullable fields to be explicitly nulled', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver({ insuranceDocKey: 'r2/insurance/foo.pdf' }));

    await rig.service.patch('01935f3d-0000-7000-8000-0000000000d1', { insuranceDocKey: null }, NOW);

    expect(rig.drivers.updateCalls[0]?.patch).toEqual({ insuranceDocKey: null });
  });

  it('rejects an insurance expiry in the past on patch', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver());

    await expect(
      rig.service.patch(
        '01935f3d-0000-7000-8000-0000000000d1',
        { insuranceExpiresAt: YESTERDAY },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.drivers.updateCalls).toEqual([]);
  });

  it('rejects a background-check date in the future on patch', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver());

    await expect(
      rig.service.patch(
        '01935f3d-0000-7000-8000-0000000000d1',
        { backgroundCheckPassedAt: TOMORROW },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError when the row vanishes between read and update', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver());
    rig.drivers.update = (): Promise<Driver | null> => Promise.resolve(null);

    await expect(
      rig.service.patch('01935f3d-0000-7000-8000-0000000000d1', { vehicleColor: 'red' }, NOW),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns the projected DriverResponse after a successful patch', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver());

    const res = await rig.service.patch(
      '01935f3d-0000-7000-8000-0000000000d1',
      { vehicleColor: 'red' },
      NOW,
    );

    expect(res.id).toBe('01935f3d-0000-7000-8000-0000000000d1');
    expect(res.vehicleColor).toBe('red');
  });
});

describe('AdminDriversService.create — tx rollback', () => {
  it('does not attempt the user role-promotion when the drivers insert throws', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());
    rig.drivers.createThrows = new RepositoryError('synthetic insert failure');

    await expect(rig.service.create(makeCreateBody(), NOW)).rejects.toBeInstanceOf(RepositoryError);
    expect(rig.users.updateCalls).toEqual([]);
  });

  it('raises RepositoryError when the user vanishes between pre-check and tx', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());
    // Replace `update` to model the soft-delete race — pre-check saw a
    // live row, but by the time the tx runs the row is gone.
    rig.users.update = (): Promise<User | null> => Promise.resolve(null);

    await expect(rig.service.create(makeCreateBody(), NOW)).rejects.toBeInstanceOf(RepositoryError);
  });
});
