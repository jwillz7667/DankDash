/**
 * Unit tests for AccountDeletionService.
 *
 * The service orchestrates six repositories inside one `db.transaction(...)`.
 * Per the project's service-test convention (see CartService), the fake db's
 * `transaction(fn)` just invokes `fn(tx)` directly — the fakes don't model
 * rollback, so what we assert is the *contract*: the ordered side effects on
 * the happy path, the active-order refusal (409), and the not-found / already-
 * deleted guards (404, same shape for both so a probe can't distinguish).
 *
 * Coverage focus:
 *   - happy path: sessions revoked, reset tokens invalidated, addresses +
 *     payment methods soft-deleted, user anonymized; response carries the
 *     tombstone timestamp from the anonymized row
 *   - ordering: the active-order guard runs BEFORE any destructive write
 *   - active orders → ConflictError ACCOUNT_HAS_ACTIVE_ORDERS, nothing torn
 *     down
 *   - unknown user → NotFoundError, no writes
 *   - already-deleted user → NotFoundError (idempotent re-delete), no writes
 *   - concurrent-delete race (anonymize returns null) → NotFoundError
 */
import { ConflictError, NotFoundError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountDeletionService,
  type AccountDeletionScopedRepos,
  type AccountDeletionScopedReposFactory,
} from './account-deletion.service.js';
import type {
  Database,
  FavoritesRepository,
  OrdersRepository,
  PasswordResetTokensRepository,
  PaymentMethodsRepository,
  SessionsRepository,
  User,
  UserAddressesRepository,
  UsersRepository,
} from '@dankdash/db';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DELETED_AT = new Date('2026-06-09T12:00:00.000Z');

function makeUser(overrides: Partial<User> = {}): User {
  const at = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: USER_ID,
    email: 'jane@example.com',
    phone: '+16125550100',
    passwordHash: 'argon2:real-hash',
    role: 'customer',
    status: 'active',
    firstName: 'Jane',
    lastName: 'Doe',
    dateOfBirth: '1990-01-01',
    kycVerifiedAt: at,
    kycProvider: 'persona',
    kycProviderRef: 'inq_123',
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: at,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    ...overrides,
  };
}

/** Records side effects in call order so ordering can be asserted. */
class Recorder {
  readonly log: string[] = [];
}

class FakeUsersRepo {
  public found: User | null = makeUser();
  public anonymizeResult: User | null = makeUser({ deletedAt: DELETED_AT });
  public findByIdCalls: string[] = [];
  public anonymizeCalls: string[] = [];

  constructor(private readonly rec: Recorder) {}

  findById = (id: string): Promise<User | null> => {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.found);
  };

  anonymizeAndSoftDelete = (id: string): Promise<User | null> => {
    this.rec.log.push('users.anonymizeAndSoftDelete');
    this.anonymizeCalls.push(id);
    return Promise.resolve(this.anonymizeResult);
  };
}

class FakeOrdersRepo {
  public activeCount = 0;
  public countCalls: string[] = [];

  countActiveForUser = (userId: string): Promise<number> => {
    this.countCalls.push(userId);
    return Promise.resolve(this.activeCount);
  };
}

class FakeSessionsRepo {
  public revokeCalls: string[] = [];
  constructor(private readonly rec: Recorder) {}
  revokeAllForUser = (userId: string): Promise<void> => {
    this.rec.log.push('sessions.revokeAllForUser');
    this.revokeCalls.push(userId);
    return Promise.resolve();
  };
}

class FakeResetTokensRepo {
  public invalidateCalls: string[] = [];
  constructor(private readonly rec: Recorder) {}
  invalidateAllActiveForUser = (userId: string): Promise<number> => {
    this.rec.log.push('passwordResetTokens.invalidateAllActiveForUser');
    this.invalidateCalls.push(userId);
    return Promise.resolve(1);
  };
}

class FakeAddressesRepo {
  public softDeleteCalls: string[] = [];
  constructor(private readonly rec: Recorder) {}
  softDeleteAllForUser = (userId: string): Promise<number> => {
    this.rec.log.push('userAddresses.softDeleteAllForUser');
    this.softDeleteCalls.push(userId);
    return Promise.resolve(2);
  };
}

class FakePaymentMethodsRepo {
  public softDeleteCalls: string[] = [];
  constructor(private readonly rec: Recorder) {}
  softDeleteAllForUser = (userId: string): Promise<number> => {
    this.rec.log.push('paymentMethods.softDeleteAllForUser');
    this.softDeleteCalls.push(userId);
    return Promise.resolve(1);
  };
}

class FakeFavoritesRepo {
  public deleteCalls: string[] = [];
  constructor(private readonly rec: Recorder) {}
  deleteAllForUser = (userId: string): Promise<number> => {
    this.rec.log.push('favorites.deleteAllForUser');
    this.deleteCalls.push(userId);
    return Promise.resolve(3);
  };
}

interface Rig {
  readonly service: AccountDeletionService;
  readonly rec: Recorder;
  readonly users: FakeUsersRepo;
  readonly orders: FakeOrdersRepo;
  readonly sessions: FakeSessionsRepo;
  readonly resetTokens: FakeResetTokensRepo;
  readonly addresses: FakeAddressesRepo;
  readonly paymentMethods: FakePaymentMethodsRepo;
  readonly favorites: FakeFavoritesRepo;
}

function makeRig(): Rig {
  const rec = new Recorder();
  const users = new FakeUsersRepo(rec);
  const orders = new FakeOrdersRepo();
  const sessions = new FakeSessionsRepo(rec);
  const resetTokens = new FakeResetTokensRepo(rec);
  const addresses = new FakeAddressesRepo(rec);
  const paymentMethods = new FakePaymentMethodsRepo(rec);
  const favorites = new FakeFavoritesRepo(rec);

  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;

  const factory: AccountDeletionScopedReposFactory = () =>
    ({
      users: users as unknown as UsersRepository,
      sessions: sessions as unknown as SessionsRepository,
      passwordResetTokens: resetTokens as unknown as PasswordResetTokensRepository,
      userAddresses: addresses as unknown as UserAddressesRepository,
      paymentMethods: paymentMethods as unknown as PaymentMethodsRepository,
      orders: orders as unknown as OrdersRepository,
      favorites: favorites as unknown as FavoritesRepository,
    }) satisfies AccountDeletionScopedRepos;

  return {
    service: new AccountDeletionService(fakeDb, factory),
    rec,
    users,
    orders,
    sessions,
    resetTokens,
    addresses,
    paymentMethods,
    favorites,
  };
}

describe('AccountDeletionService.deleteAccount', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig();
  });

  it('tears down the account and returns the tombstone timestamp', async () => {
    const res = await rig.service.deleteAccount(USER_ID);

    expect(res).toEqual({ deletedAt: DELETED_AT.toISOString() });
    expect(rig.sessions.revokeCalls).toEqual([USER_ID]);
    expect(rig.resetTokens.invalidateCalls).toEqual([USER_ID]);
    expect(rig.addresses.softDeleteCalls).toEqual([USER_ID]);
    expect(rig.paymentMethods.softDeleteCalls).toEqual([USER_ID]);
    expect(rig.favorites.deleteCalls).toEqual([USER_ID]);
    expect(rig.users.anonymizeCalls).toEqual([USER_ID]);
  });

  it('runs the active-order guard before any destructive write', async () => {
    await rig.service.deleteAccount(USER_ID);

    // Sessions revoke is the first destructive step; the count must precede it.
    expect(rig.orders.countCalls).toEqual([USER_ID]);
    expect(rig.rec.log[0]).toBe('sessions.revokeAllForUser');
    expect(rig.rec.log[rig.rec.log.length - 1]).toBe('users.anonymizeAndSoftDelete');
  });

  it('refuses with 409 when an order is still in flight, touching nothing', async () => {
    rig.orders.activeCount = 1;

    await expect(rig.service.deleteAccount(USER_ID)).rejects.toMatchObject({
      code: 'ACCOUNT_HAS_ACTIVE_ORDERS',
      statusCode: 409,
      details: { activeOrders: 1 },
    });
    await expect(rig.service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(ConflictError);

    expect(rig.rec.log).toEqual([]);
    expect(rig.users.anonymizeCalls).toEqual([]);
  });

  it('returns 404 for an unknown user and writes nothing', async () => {
    rig.users.found = null;

    await expect(rig.service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(NotFoundError);

    expect(rig.orders.countCalls).toEqual([]);
    expect(rig.rec.log).toEqual([]);
  });

  it('returns 404 for an already-deleted user (idempotent re-delete)', async () => {
    rig.users.found = makeUser({ deletedAt: DELETED_AT });

    await expect(rig.service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(NotFoundError);

    expect(rig.rec.log).toEqual([]);
  });

  it('returns 404 when a concurrent delete wins the anonymize race', async () => {
    rig.users.anonymizeResult = null;

    await expect(rig.service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(NotFoundError);

    // The destructive prelude still ran (same tx, rolled back in prod).
    expect(rig.users.anonymizeCalls).toEqual([USER_ID]);
  });
});
