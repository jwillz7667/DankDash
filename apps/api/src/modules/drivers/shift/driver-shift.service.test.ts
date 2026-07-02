/**
 * Unit tests for DriverShiftService.
 *
 * What's pinned here:
 *   start()
 *     1. Reads the drivers row under FOR UPDATE inside one tx, then
 *        promotes the row from `offline` → `online` and inserts a shift.
 *     2. Refuses to start a shift if the row is not in `offline` (i.e.
 *        a stale guard-snapshot cannot smuggle a double-start past the
 *        re-read).
 *     3. Refuses if a `driver_shifts` row with `ended_at IS NULL`
 *        already exists for the driver, even if the drivers row says
 *        `offline` (belt-and-suspenders against partial-update bugs).
 *     4. Refuses to start if onboarding is incomplete: no background
 *        check, or insurance lapsed. The insurance comparison treats
 *        "expires today" as still valid (policy in force through EOD).
 *   end()
 *     1. Closes the active shift and demotes status to `offline`.
 *     2. Refuses if no active shift.
 *     3. Refuses if the driver is mid-delivery (`en_route_pickup` /
 *        `en_route_dropoff`) — those statuses must clear via the
 *        order machine before the driver can punch out.
 *     4. Allows ending from `on_break` / `unavailable` — those are
 *        on-shift unavailability, not assignments.
 *   updateStatus()
 *     1. Permits transitions inside {online, on_break, unavailable}.
 *     2. Refuses to set from `offline` (must use shift/start) or from
 *        `en_route_*` (lifecycle-managed by the order machine).
 *     3. No-ops when current === target (skips the UPDATE).
 *
 * `now` is pinned to a known instant so the date assertions are
 * deterministic. The fake `db.transaction` invokes its inner function
 * with the same fake repo handle — this pins the *logic*, not the SQL.
 */
import { DriverError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { DriverShiftService, type DriverShiftScopedRepos } from './driver-shift.service.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type {
  Database,
  Driver,
  DriverShift,
  DriverShiftsRepository,
  DriverStatus,
  DriversRepository,
  GeoPoint,
} from '@dankdash/db';

const NOW = new Date('2026-05-18T19:00:00.000Z');
const TODAY_ISO = '2026-05-18';
const YESTERDAY_ISO = '2026-05-17';
const TOMORROW_ISO = '2026-05-19';

const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const SHIFT_ID = '01935f3d-0000-7000-8000-0000000000f1';

const START_LOC: GeoPoint = { type: 'Point', coordinates: [-93.265, 44.977] };
const END_LOC: GeoPoint = { type: 'Point', coordinates: [-93.27, 44.98] };

function makeContext(currentStatus: DriverStatus = 'offline'): DriverContext {
  return {
    driverId: DRIVER_ID,
    userId: USER_ID,
    currentStatus,
    currentOrderId: null,
  };
}

function makeDriver(overrides: Partial<Driver> = {}): Driver {
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
    insuranceExpiresAt: TOMORROW_ISO,
    backgroundCheckPassedAt: YESTERDAY_ISO,
    backgroundCheckProviderRef: null,
    aeropayAccountRef: null,
    currentStatus: 'offline',
    lastStatusChangeAt: NOW,
    currentLocation: null,
    currentLocationUpdatedAt: null,
    currentOrderId: null,
    ratingAvg: null,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeShift(overrides: Partial<DriverShift> = {}): DriverShift {
  return {
    id: SHIFT_ID,
    driverId: DRIVER_ID,
    startedAt: NOW,
    endedAt: null,
    startingLocation: START_LOC,
    endingLocation: null,
    totalMiles: null,
    totalDeliveries: 0,
    totalEarningsCents: 0,
    ...overrides,
  };
}

class FakeDriversRepo implements Pick<
  DriversRepository,
  'findByIdForUpdate' | 'setStatus' | 'updateLocation'
> {
  public row: Driver | null = null;
  public lockCalls: string[] = [];
  public statusCalls: { id: string; status: DriverStatus }[] = [];
  public locationCalls: { id: string; location: GeoPoint; at: Date | undefined }[] = [];

  findByIdForUpdate(id: string): Promise<Driver | null> {
    this.lockCalls.push(id);
    return Promise.resolve(this.row);
  }

  setStatus(id: string, status: DriverStatus): Promise<void> {
    this.statusCalls.push({ id, status });
    if (this.row !== null) {
      this.row = { ...this.row, currentStatus: status, lastStatusChangeAt: NOW };
    }
    return Promise.resolve();
  }

  updateLocation(id: string, location: GeoPoint, recordedAt?: Date): Promise<void> {
    this.locationCalls.push({ id, location, at: recordedAt });
    if (this.row !== null) {
      this.row = {
        ...this.row,
        currentLocation: location,
        currentLocationUpdatedAt: recordedAt ?? NOW,
      };
    }
    return Promise.resolve();
  }
}

class FakeShiftsRepo implements Pick<
  DriverShiftsRepository,
  'findActiveForDriver' | 'start' | 'end'
> {
  public active: DriverShift | null = null;
  public startCalls: { driverId: string; location: GeoPoint; at: Date }[] = [];
  public endCalls: { id: string; location: GeoPoint; at: Date }[] = [];

  findActiveForDriver(driverId: string): Promise<DriverShift | null> {
    if (this.active !== null && this.active.driverId === driverId) {
      return Promise.resolve(this.active);
    }
    return Promise.resolve(null);
  }

  start(driverId: string, location: GeoPoint, startedAt: Date = new Date()): Promise<DriverShift> {
    this.startCalls.push({ driverId, location, at: startedAt });
    const row = makeShift({ driverId, startingLocation: location, startedAt });
    this.active = row;
    return Promise.resolve(row);
  }

  end(id: string, location: GeoPoint, endedAt: Date = new Date()): Promise<DriverShift | null> {
    this.endCalls.push({ id, location, at: endedAt });
    if (this.active?.id !== id) return Promise.resolve(null);
    const row: DriverShift = {
      ...this.active,
      endedAt,
      endingLocation: location,
    };
    this.active = null;
    return Promise.resolve(row);
  }
}

interface Rig {
  readonly service: DriverShiftService;
  readonly drivers: FakeDriversRepo;
  readonly shifts: FakeShiftsRepo;
  txCallCount(): number;
}

function makeRig(): Rig {
  const drivers = new FakeDriversRepo();
  const shifts = new FakeShiftsRepo();
  let txCallCount = 0;
  const fakeDb = {
    transaction: <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      txCallCount += 1;
      return fn(fakeDb as unknown as Database);
    },
  };
  const scopedReposFor = (): DriverShiftScopedRepos => ({
    drivers: drivers as unknown as DriversRepository,
    shifts: shifts as unknown as DriverShiftsRepository,
  });
  const service = new DriverShiftService(fakeDb as unknown as Database, scopedReposFor);
  return {
    service,
    drivers,
    shifts,
    txCallCount: (): number => txCallCount,
  };
}

describe('DriverShiftService.start', () => {
  it('opens a shift, sets driver to online, runs inside one tx', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver();

    const res = await rig.service.start(makeContext(), { startingLocation: START_LOC }, NOW);

    expect(rig.txCallCount()).toBe(1);
    expect(rig.drivers.lockCalls).toEqual([DRIVER_ID]);
    expect(rig.shifts.startCalls).toEqual([{ driverId: DRIVER_ID, location: START_LOC, at: NOW }]);
    expect(rig.drivers.statusCalls).toEqual([{ id: DRIVER_ID, status: 'online' }]);
    expect(res.driverId).toBe(DRIVER_ID);
    expect(res.endedAt).toBeNull();
    expect(res.startingLocation).toEqual(START_LOC);
  });

  it('seeds current_location from the starting point so dispatch can see the driver', async () => {
    // Regression: an online driver with current_location IS NULL is
    // invisible to findDispatchCandidatesNearDispensary, so every nearby
    // order fast-failed to dispatch_failed. Starting a shift must seed the
    // live location from the shift's starting point, stamped at `now`.
    const rig = makeRig();
    rig.drivers.row = makeDriver();

    await rig.service.start(makeContext(), { startingLocation: START_LOC }, NOW);

    expect(rig.drivers.locationCalls).toEqual([{ id: DRIVER_ID, location: START_LOC, at: NOW }]);
    // The seeded row must be both online and locatable for eligibility.
    expect(rig.drivers.row?.currentStatus).toBe('online');
    expect(rig.drivers.row?.currentLocation).toEqual(START_LOC);
  });

  it.each(['online', 'on_break', 'unavailable', 'en_route_pickup', 'en_route_dropoff'] as const)(
    'refuses to start when the driver is %s (must be offline)',
    async (status) => {
      const rig = makeRig();
      rig.drivers.row = makeDriver({ currentStatus: status });

      const err = await rig.service
        .start(makeContext(status), { startingLocation: START_LOC }, NOW)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe('DRIVER_SHIFT_ALREADY_ACTIVE');
      expect(rig.shifts.startCalls).toEqual([]);
      expect(rig.drivers.statusCalls).toEqual([]);
    },
  );

  it('refuses when an open shift already exists even if driver row says offline', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ currentStatus: 'offline' });
    rig.shifts.active = makeShift();

    const err = await rig.service
      .start(makeContext(), { startingLocation: START_LOC }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_SHIFT_ALREADY_ACTIVE');
    expect(rig.shifts.startCalls).toEqual([]);
  });

  it('refuses if background check has not been recorded', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ backgroundCheckPassedAt: null });

    const err = await rig.service
      .start(makeContext(), { startingLocation: START_LOC }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_BACKGROUND_INCOMPLETE');
  });

  it('refuses if insurance expired before today', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ insuranceExpiresAt: YESTERDAY_ISO });

    const err = await rig.service
      .start(makeContext(), { startingLocation: START_LOC }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_INSURANCE_EXPIRED');
  });

  it('allows insurance expiring today (valid through end-of-day)', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ insuranceExpiresAt: TODAY_ISO });

    const res = await rig.service.start(makeContext(), { startingLocation: START_LOC }, NOW);
    expect(res.driverId).toBe(DRIVER_ID);
  });

  it('allows null insuranceExpiresAt (no policy on file is not a self-block)', async () => {
    // The admin onboarding flow doesn't require insurance to be present
    // at create-time; this matches the create DTO. Insurance expiry is
    // only enforced when *populated*. Operator policy can refuse to set
    // status='active' until insurance is present, but the runtime check
    // here is a freshness gate, not a presence gate.
    const rig = makeRig();
    rig.drivers.row = makeDriver({ insuranceExpiresAt: null });

    const res = await rig.service.start(makeContext(), { startingLocation: START_LOC }, NOW);
    expect(res.driverId).toBe(DRIVER_ID);
  });

  it('throws DRIVER_NOT_FOUND if the row disappears between guard and tx', async () => {
    const rig = makeRig();
    rig.drivers.row = null;

    const err = await rig.service
      .start(makeContext(), { startingLocation: START_LOC }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_NOT_FOUND');
  });
});

describe('DriverShiftService.end', () => {
  it('closes the active shift and sets driver to offline', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ currentStatus: 'online' });
    rig.shifts.active = makeShift();

    const res = await rig.service.end(makeContext('online'), { endingLocation: END_LOC }, NOW);

    expect(rig.txCallCount()).toBe(1);
    expect(rig.drivers.lockCalls).toEqual([DRIVER_ID]);
    expect(rig.shifts.endCalls).toEqual([{ id: SHIFT_ID, location: END_LOC, at: NOW }]);
    expect(rig.drivers.statusCalls).toEqual([{ id: DRIVER_ID, status: 'offline' }]);
    expect(res.endedAt).toBe(NOW.toISOString());
    expect(res.endingLocation).toEqual(END_LOC);
  });

  it('refuses when no active shift exists', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ currentStatus: 'online' });
    rig.shifts.active = null;

    const err = await rig.service
      .end(makeContext('online'), { endingLocation: END_LOC }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_SHIFT_NOT_ACTIVE');
    expect(rig.drivers.statusCalls).toEqual([]);
  });

  it.each(['en_route_pickup', 'en_route_dropoff'] as const)(
    'refuses to end while the driver is %s (must clear via order machine)',
    async (status) => {
      const rig = makeRig();
      rig.drivers.row = makeDriver({
        currentStatus: status,
        currentOrderId: '01935f3d-0000-7000-8000-0000000000ee',
      });
      rig.shifts.active = makeShift();

      const err = await rig.service
        .end(makeContext(status), { endingLocation: END_LOC }, NOW)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe('DRIVER_BUSY_WITH_ORDER');
      expect(rig.shifts.endCalls).toEqual([]);
      expect(rig.drivers.statusCalls).toEqual([]);
    },
  );

  it.each(['on_break', 'unavailable'] as const)(
    'allows ending from %s (on-shift unavailability, not an assignment)',
    async (status) => {
      const rig = makeRig();
      rig.drivers.row = makeDriver({ currentStatus: status });
      rig.shifts.active = makeShift();

      const res = await rig.service.end(makeContext(status), { endingLocation: END_LOC }, NOW);

      expect(res.endedAt).toBe(NOW.toISOString());
      expect(rig.drivers.statusCalls).toEqual([{ id: DRIVER_ID, status: 'offline' }]);
    },
  );
});

describe('DriverShiftService.updateStatus', () => {
  it.each([
    ['online', 'on_break'],
    ['online', 'unavailable'],
    ['on_break', 'online'],
    ['on_break', 'unavailable'],
    ['unavailable', 'online'],
    ['unavailable', 'on_break'],
  ] as const)('allows %s → %s', async (from, to) => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ currentStatus: from });

    const res = await rig.service.updateStatus(makeContext(from), to);

    expect(rig.drivers.statusCalls).toEqual([{ id: DRIVER_ID, status: to }]);
    expect(res.currentStatus).toBe(to);
  });

  it.each(['offline', 'en_route_pickup', 'en_route_dropoff'] as const)(
    'refuses to self-set status from %s',
    async (from) => {
      const rig = makeRig();
      rig.drivers.row = makeDriver({ currentStatus: from });

      const err = await rig.service
        .updateStatus(makeContext(from), 'on_break')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe('DRIVER_STATUS_INVALID');
      expect(rig.drivers.statusCalls).toEqual([]);
    },
  );

  it('no-ops when current === target (skips the UPDATE)', async () => {
    const rig = makeRig();
    rig.drivers.row = makeDriver({ currentStatus: 'on_break' });

    const res = await rig.service.updateStatus(makeContext('on_break'), 'on_break');

    expect(rig.drivers.statusCalls).toEqual([]);
    expect(res.currentStatus).toBe('on_break');
  });

  it('throws DRIVER_NOT_FOUND when the row vanishes', async () => {
    const rig = makeRig();
    rig.drivers.row = null;

    const err = await rig.service
      .updateStatus(makeContext('online'), 'on_break')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('DRIVER_NOT_FOUND');
  });
});
