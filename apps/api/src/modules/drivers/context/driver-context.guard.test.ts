/**
 * Unit tests for DriverContextGuard.
 *
 *   1. No req.user (route misconfigured @Public) — AuthError UNAUTHENTICATED.
 *   2. Authenticated principal with a non-driver global role —
 *      ForbiddenError. RolesGuard could enforce this, but every
 *      driver-self route uses this guard alone so the check lives here.
 *   3. Driver-roled principal with no `drivers` row — ForbiddenError
 *      (NOT 404). A probing call must not be able to distinguish
 *      "this user has no driver profile" from "I don't have access".
 *   4. Happy path — attaches { driverId, userId, currentStatus,
 *      currentOrderId } to req[DRIVER_CONTEXT_REQUEST_KEY].
 *   5. currentStatus / currentOrderId snapshot — handlers that need the
 *      latest must re-read inside their tx; the context is informational.
 */
import { AuthError, ForbiddenError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { DriverContextGuard } from './driver-context.guard.js';
import { DRIVER_CONTEXT_REQUEST_KEY, type DriverContext } from './driver-context.types.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { Driver, DriversRepository } from '@dankdash/db';
import type { ExecutionContext } from '@nestjs/common';

const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const ORDER_ID = '01935f3d-0000-7000-8000-0000000000e1';

interface FakeRequest {
  readonly headers: Record<string, string | undefined>;
  user?: AuthenticatedUser;
  [DRIVER_CONTEXT_REQUEST_KEY]?: DriverContext;
}

function makeContext(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: (): unknown => ({
      getRequest: (): FakeRequest => req,
      getResponse: (): unknown => ({}),
      getNext: (): unknown => ({}),
    }),
    switchToRpc: (): unknown => ({}),
    switchToWs: (): unknown => ({}),
    getHandler: (): unknown => undefined,
    getClass: (): unknown => undefined,
    getArgs: (): readonly unknown[] => [],
    getArgByIndex: (): unknown => undefined,
    getType: (): string => 'http',
  } as unknown as ExecutionContext;
}

function makeAuthenticatedUser(role: AuthenticatedUser['role'] = 'driver'): AuthenticatedUser {
  return {
    userId: USER_ID,
    sessionId: '01935f3d-0000-7000-8000-0000000000bb',
    role,
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

class FakeDriversRepo {
  public next: Driver | null = null;
  public calls: string[] = [];

  findByUserId = (userId: string): Promise<Driver | null> => {
    this.calls.push(userId);
    return Promise.resolve(this.next);
  };
}

function buildGuard(): { guard: DriverContextGuard; drivers: FakeDriversRepo } {
  const drivers = new FakeDriversRepo();
  const guard = new DriverContextGuard(drivers as unknown as DriversRepository);
  return { guard, drivers };
}

describe('DriverContextGuard', () => {
  it('throws UNAUTHENTICATED when req.user is missing', async () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(AuthError);
  });

  it('throws ForbiddenError when the principal is not a driver', async () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser('customer') };

    const err = await guard.canActivate(makeContext(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('throws ForbiddenError (not NotFoundError) when no drivers row exists for the user', async () => {
    const { guard, drivers } = buildGuard();
    drivers.next = null;
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser('driver') };

    const err = await guard.canActivate(makeContext(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    // Specifically NOT a NotFoundError — surfacing 403 means a probing
    // call cannot distinguish "user X has no driver profile" from
    // "you are not allowed to see this".
    expect((err as Error).name).not.toBe('NotFoundError');
  });

  it('attaches the DriverContext on the happy path and returns true', async () => {
    const { guard, drivers } = buildGuard();
    drivers.next = makeDriver({ currentStatus: 'online', currentOrderId: ORDER_ID });
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser('driver') };

    const result = await guard.canActivate(makeContext(req));

    expect(result).toBe(true);
    const ctx = req[DRIVER_CONTEXT_REQUEST_KEY];
    expect(ctx).toEqual({
      driverId: DRIVER_ID,
      userId: USER_ID,
      currentStatus: 'online',
      currentOrderId: ORDER_ID,
    });
    expect(drivers.calls).toEqual([USER_ID]);
  });

  it('reflects the offline status in the attached context (informational snapshot)', async () => {
    const { guard, drivers } = buildGuard();
    drivers.next = makeDriver({ currentStatus: 'offline', currentOrderId: null });
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser('driver') };

    await guard.canActivate(makeContext(req));

    expect(req[DRIVER_CONTEXT_REQUEST_KEY]?.currentStatus).toBe('offline');
    expect(req[DRIVER_CONTEXT_REQUEST_KEY]?.currentOrderId).toBeNull();
  });

  it('passes the userId through unchanged (drivers.id, not users.id, is the FK target)', async () => {
    const { guard, drivers } = buildGuard();
    drivers.next = makeDriver();
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser('driver') };

    await guard.canActivate(makeContext(req));

    const ctx = req[DRIVER_CONTEXT_REQUEST_KEY];
    expect(ctx?.driverId).toBe(DRIVER_ID);
    expect(ctx?.userId).toBe(USER_ID);
  });
});
