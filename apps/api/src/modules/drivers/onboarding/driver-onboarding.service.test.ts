/**
 * Unit tests for DriverOnboardingService.
 *
 * Behaviours pinned:
 *   - me()      projects an existing drivers row (no license-number-hash
 *               leak) and 404s a principal with no drivers row.
 *   - apply()   on a fresh principal hashes the license under the
 *               DRIVER_LICENSE_NUMBER context, inserts a PENDING drivers
 *               row (backgroundCheckPassedAt = null) AND promotes the
 *               user to role=driver inside one tx, and returns
 *               { status: 'pending' }.
 *   - apply()   is idempotent: a pending row is refreshed (vehicle only,
 *               no second create) and still reports pending; an already-
 *               activated row reports approved without touching the DB.
 *   - apply()   raises RepositoryError when the authenticated user is
 *               missing, and never promotes the role when the insert
 *               throws (tx rollback contract).
 *
 * The fake tx-handle calls the inner function with the same fake repos —
 * the production code uses a real Postgres transaction; this pins the
 * *logic*, not the SQL. Mirrors admin-drivers.service.test.ts.
 */
import { NotFoundError, RepositoryError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  DriverOnboardingService,
  type DriverOnboardingScopedRepos,
} from './driver-onboarding.service.js';
import type { DriverApplicationRequest } from './dto/index.js';
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

const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';

function makeUser(overrides: Partial<User> = {}): User {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: USER_ID,
    email: 'applicant@example.com',
    phone: null,
    passwordHash: '$argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Alex',
    lastName: 'Applicant',
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
    id: DRIVER_ID,
    userId: USER_ID,
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
    aeropayAccountRef: null,
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

function makeApplyBody(
  overrides: Partial<DriverApplicationRequest> = {},
): DriverApplicationRequest {
  return {
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehicleYear: 2023,
    vehiclePlate: 'ABC-1234',
    vehicleColor: 'white',
    licenseNumber: 'DL-12345',
    documents: [
      { kind: 'drivers_license', storageKey: 'dl.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 },
      {
        kind: 'vehicle_insurance',
        storageKey: 'ins.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      },
      {
        kind: 'vehicle_registration',
        storageKey: 'reg.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3072,
      },
    ],
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
    const next: User = { ...existing, ...(patch as Partial<User>) };
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
      id: input.id ?? DRIVER_ID,
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
      aeropayAccountRef: input.aeropayAccountRef ?? null,
    });
    this.byId.set(row.id, row);
    this.byUserId.set(row.userId, row);
    return Promise.resolve(row);
  }

  update(id: string, patch: DriverPatchInput): Promise<Driver | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.byId.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Driver = { ...existing, ...(patch as unknown as Partial<Driver>) };
    this.byId.set(id, next);
    this.byUserId.set(next.userId, next);
    return Promise.resolve(next);
  }
}

class FakeHasher implements DocumentHasher {
  public hashCalls: { value: string; context: string }[] = [];

  hash(value: string, context: string): Uint8Array {
    this.hashCalls.push({ value, context });
    const buf = Buffer.alloc(32);
    for (let i = 0; i < value.length && i < 32; i += 1) {
      buf[i] = value.charCodeAt(i) ^ context.length;
    }
    return new Uint8Array(buf);
  }

  matches(stored: Uint8Array, value: string, context: string): boolean {
    return Buffer.from(stored).equals(Buffer.from(this.hash(value, context)));
  }
}

interface Rig {
  readonly service: DriverOnboardingService;
  readonly drivers: FakeDriversRepo;
  readonly users: FakeUsersRepo;
  readonly hasher: FakeHasher;
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
      return fn(fakeDb as unknown as Database);
    },
  };
  const scopedReposFor = (): DriverOnboardingScopedRepos => ({
    drivers: drivers as unknown as DriversRepository,
    users: users as unknown as UsersRepository,
  });
  const service = new DriverOnboardingService(
    drivers as unknown as DriversRepository,
    users as unknown as UsersRepository,
    fakeDb as unknown as Database,
    scopedReposFor,
    hasher,
  );
  return { service, drivers, users, hasher, txCalled: (): boolean => txCalled };
}

describe('DriverOnboardingService.me', () => {
  it('projects an existing drivers row without the license-number hash', async () => {
    const rig = makeRig();
    rig.drivers.seed(makeDriver({ vehicleMake: 'Toyota' }));

    const res = await rig.service.me(USER_ID);

    expect(res.id).toBe(DRIVER_ID);
    expect(res.userId).toBe(USER_ID);
    expect(res.vehicleMake).toBe('Toyota');
    expect(res.backgroundCheckPassedAt).toBeNull();
    expect((res as { licenseNumberHash?: unknown }).licenseNumberHash).toBeUndefined();
  });

  it('throws NotFoundError when the principal has no drivers row', async () => {
    const rig = makeRig();

    const err = await rig.service.me(USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).statusCode).toBe(404);
  });
});

describe('DriverOnboardingService.apply — fresh principal', () => {
  it('hashes the license number under the DRIVER_LICENSE_NUMBER context', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.apply(USER_ID, makeApplyBody({ licenseNumber: 'DL-12345' }));

    expect(rig.hasher.hashCalls).toEqual([
      { value: 'DL-12345', context: 'drivers.license_number' },
    ]);
  });

  it('inserts a PENDING row and promotes the role inside one tx', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    const res = await rig.service.apply(USER_ID, makeApplyBody());

    expect(rig.txCalled()).toBe(true);
    expect(rig.drivers.createCalls).toHaveLength(1);
    const input = rig.drivers.createCalls[0];
    expect(input?.userId).toBe(USER_ID);
    expect(input?.backgroundCheckPassedAt).toBeNull();
    expect(input?.insuranceDocKey).toBeNull();
    expect(input?.vehicleMake).toBe('Toyota');
    expect(rig.users.updateCalls).toEqual([{ id: USER_ID, patch: { role: 'driver' } }]);
    expect(res).toEqual({ applicationId: DRIVER_ID, status: 'pending', queuePosition: null });
  });

  it('stores the 32-byte hash output on the new row', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());

    await rig.service.apply(USER_ID, makeApplyBody());

    const input = rig.drivers.createCalls[0];
    expect(input?.licenseNumberHash).toBeInstanceOf(Uint8Array);
    expect(input?.licenseNumberHash.length).toBe(32);
  });

  it('raises RepositoryError when the authenticated user is missing', async () => {
    const rig = makeRig();

    await expect(rig.service.apply(USER_ID, makeApplyBody())).rejects.toBeInstanceOf(
      RepositoryError,
    );
    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
  });

  it('raises RepositoryError when the user is soft-deleted', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(rig.service.apply(USER_ID, makeApplyBody())).rejects.toBeInstanceOf(
      RepositoryError,
    );
    expect(rig.drivers.createCalls).toEqual([]);
  });
});

describe('DriverOnboardingService.apply — idempotency', () => {
  it('refreshes vehicle details on a pending row and stays pending (no second create)', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ role: 'driver' }));
    rig.drivers.seed(makeDriver({ vehicleColor: 'white' }));

    const res = await rig.service.apply(USER_ID, makeApplyBody({ vehicleColor: 'red' }));

    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
    expect(rig.drivers.updateCalls).toHaveLength(1);
    expect(rig.drivers.updateCalls[0]?.patch).toEqual({
      vehicleMake: 'Toyota',
      vehicleModel: 'Prius',
      vehicleYear: 2023,
      vehiclePlate: 'ABC-1234',
      vehicleColor: 'red',
    });
    expect(res).toEqual({ applicationId: DRIVER_ID, status: 'pending', queuePosition: null });
  });

  it('reports approved without touching the DB when the row is already activated', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser({ role: 'driver' }));
    rig.drivers.seed(makeDriver({ backgroundCheckPassedAt: '2026-05-01' }));

    const res = await rig.service.apply(USER_ID, makeApplyBody());

    expect(rig.drivers.createCalls).toEqual([]);
    expect(rig.drivers.updateCalls).toEqual([]);
    expect(rig.txCalled()).toBe(false);
    expect(res).toEqual({ applicationId: DRIVER_ID, status: 'approved', queuePosition: null });
  });
});

describe('DriverOnboardingService.apply — tx rollback', () => {
  it('does not promote the role when the drivers insert throws', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());
    rig.drivers.createThrows = new RepositoryError('synthetic insert failure');

    await expect(rig.service.apply(USER_ID, makeApplyBody())).rejects.toBeInstanceOf(
      RepositoryError,
    );
    expect(rig.users.updateCalls).toEqual([]);
  });

  it('raises RepositoryError when the user vanishes between pre-check and tx', async () => {
    const rig = makeRig();
    rig.users.seed(makeUser());
    rig.users.update = (): Promise<User | null> => Promise.resolve(null);

    await expect(rig.service.apply(USER_ID, makeApplyBody())).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });
});
