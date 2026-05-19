/**
 * Driver-self shift + status orchestration.
 *
 *   start()        — POST /v1/driver/shift/start. Opens a shift row,
 *                    promotes `drivers.current_status` from `offline` to
 *                    `online`. Refuses if a shift is already active, if
 *                    the driver has not completed background check, or
 *                    if insurance has lapsed. All three checks happen
 *                    inside the same tx that creates the shift, behind a
 *                    `SELECT … FOR UPDATE` on the drivers row, so a
 *                    second device hitting `shift/start` simultaneously
 *                    blocks on the row lock and fails the "already
 *                    active" check after the first wins.
 *
 *   end()          — POST /v1/driver/shift/end. Closes the active shift
 *                    with an ending location and demotes the driver to
 *                    `offline`. Refuses if no active shift, or if the
 *                    driver is mid-delivery (`en_route_pickup`,
 *                    `en_route_dropoff`) — letting a driver go offline
 *                    with an in-flight order would orphan the order,
 *                    leaving dispatch unable to recover without manual
 *                    intervention.
 *
 *   updateStatus() — POST /v1/driver/status. Self-set transitions only
 *                    between {`online`, `on_break`, `unavailable`}.
 *                    Other status changes (offline, en_route_*) are
 *                    routed through dedicated paths (shift end and the
 *                    order state machine respectively) so the lifecycle
 *                    invariants stay in one place. Refuses any
 *                    self-set when the driver is not on a shift
 *                    (`offline` or `en_route_*`).
 *
 * The DriverContext attached by DriverContextGuard is treated as a
 * snapshot — every mutating method re-reads the drivers row under
 * `FOR UPDATE` inside the tx, so a stale snapshot cannot smuggle a
 * state change past the lifecycle check.
 */
import {
  DriverShiftsRepository,
  DriversRepository,
  type Database,
  type Driver,
  type DriverShift,
  type DriverStatus,
} from '@dankdash/db';
import { DriverError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectDriver } from '../driver.projection.js';
import { projectDriverShift } from './driver-shift.projection.js';
import {
  type DriverShiftResponse,
  type EndShiftRequest,
  type SelfSettableDriverStatus,
  type StartShiftRequest,
} from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type { DriverResponse } from '../dto/index.js';

export interface DriverShiftScopedRepos {
  readonly drivers: DriversRepository;
  readonly shifts: DriverShiftsRepository;
}
export type DriverShiftScopedReposFactory = (db: Database) => DriverShiftScopedRepos;

/**
 * Statuses a driver is *carrying* when they hit the status endpoint. A
 * self-set is only valid from one of these — offline means "not on
 * shift", en_route_* means "the order machine owns you right now".
 */
const STATUS_SELF_SETTABLE_FROM: readonly DriverStatus[] = ['online', 'on_break', 'unavailable'];

/**
 * Statuses that block ending the shift. A driver currently committed
 * to a delivery can't punch out — they must complete (or have the
 * order canceled) first. `on_break` and `unavailable` are recoverable
 * states still on the shift clock, so they DO allow ending.
 */
const STATUS_BLOCKS_SHIFT_END: readonly DriverStatus[] = ['en_route_pickup', 'en_route_dropoff'];

@Injectable()
export class DriverShiftService {
  constructor(
    private readonly db: Database,
    private readonly scopedReposFor: DriverShiftScopedReposFactory,
  ) {}

  async start(
    ctx: DriverContext,
    body: StartShiftRequest,
    now: Date = new Date(),
  ): Promise<DriverShiftResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.scopedReposFor(tx);
      const driver = await scoped.drivers.findByIdForUpdate(ctx.driverId);
      if (driver === null) {
        // Driver row vanished between guard and tx — treat as forbidden
        // rather than 404 (caller had a valid driver JWT a moment ago).
        throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
          driverId: ctx.driverId,
        });
      }

      if (driver.currentStatus !== 'offline') {
        throw new DriverError(
          'DRIVER_SHIFT_ALREADY_ACTIVE',
          'cannot start a shift while the driver is not offline',
          { driverId: ctx.driverId, currentStatus: driver.currentStatus },
        );
      }

      // Belt-and-suspenders: even if a status of `offline` slipped past
      // the driver row, an open `driver_shifts` row must not coexist
      // with a new one. The DB partial index prevents two concurrent
      // open shifts; this check turns the resulting unique violation
      // into a typed 409 instead of a generic Postgres error.
      const active = await scoped.shifts.findActiveForDriver(ctx.driverId);
      if (active !== null) {
        throw new DriverError(
          'DRIVER_SHIFT_ALREADY_ACTIVE',
          'an open shift already exists for this driver',
          { driverId: ctx.driverId, shiftId: active.id },
        );
      }

      assertOnboardingComplete(driver, now);

      const shift = await scoped.shifts.start(ctx.driverId, body.startingLocation, now);
      await scoped.drivers.setStatus(ctx.driverId, 'online');
      return projectDriverShift(shift);
    });
  }

  async end(
    ctx: DriverContext,
    body: EndShiftRequest,
    now: Date = new Date(),
  ): Promise<DriverShiftResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.scopedReposFor(tx);
      const driver = await scoped.drivers.findByIdForUpdate(ctx.driverId);
      if (driver === null) {
        throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
          driverId: ctx.driverId,
        });
      }

      if (STATUS_BLOCKS_SHIFT_END.includes(driver.currentStatus)) {
        throw new DriverError(
          'DRIVER_BUSY_WITH_ORDER',
          'cannot end shift while assigned to an active delivery',
          {
            driverId: ctx.driverId,
            currentStatus: driver.currentStatus,
            currentOrderId: driver.currentOrderId,
          },
        );
      }

      const active = await scoped.shifts.findActiveForDriver(ctx.driverId);
      if (active === null) {
        throw new DriverError('DRIVER_SHIFT_NOT_ACTIVE', 'no active shift to end', {
          driverId: ctx.driverId,
        });
      }

      const closed = await scoped.shifts.end(active.id, body.endingLocation, now);
      if (closed === null) {
        // Should be unreachable — the active row was just SELECTed.
        // Treat as a hard error so the tx rolls back the status change.
        throw new DriverError('DRIVER_SHIFT_NOT_ACTIVE', 'shift disappeared mid-tx', {
          driverId: ctx.driverId,
          shiftId: active.id,
        });
      }
      await scoped.drivers.setStatus(ctx.driverId, 'offline');
      return projectDriverShift(closed);
    });
  }

  async updateStatus(
    ctx: DriverContext,
    status: SelfSettableDriverStatus,
  ): Promise<DriverResponse> {
    return this.db.transaction(async (tx) => {
      const scoped = this.scopedReposFor(tx);
      const driver = await scoped.drivers.findByIdForUpdate(ctx.driverId);
      if (driver === null) {
        throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
          driverId: ctx.driverId,
        });
      }

      if (!STATUS_SELF_SETTABLE_FROM.includes(driver.currentStatus)) {
        throw new DriverError(
          'DRIVER_STATUS_INVALID',
          `cannot self-set status from ${driver.currentStatus}`,
          { driverId: ctx.driverId, from: driver.currentStatus, to: status },
        );
      }

      // Noop UPDATE on the same status is wasted I/O — short-circuit
      // and return the current row instead. Keeps the `last_status_change_at`
      // timestamp meaningful (only real transitions advance it).
      if (driver.currentStatus !== status) {
        await scoped.drivers.setStatus(ctx.driverId, status);
        const refreshed = await scoped.drivers.findByIdForUpdate(ctx.driverId);
        if (refreshed === null) {
          throw new DriverError('DRIVER_NOT_FOUND', 'driver row vanished mid-tx', {
            driverId: ctx.driverId,
          });
        }
        return projectDriver(refreshed);
      }
      return projectDriver(driver);
    });
  }
}

function assertOnboardingComplete(driver: Driver, now: Date): asserts driver is Driver {
  if (driver.backgroundCheckPassedAt === null) {
    throw new DriverError(
      'DRIVER_BACKGROUND_INCOMPLETE',
      'background check has not been recorded for this driver',
      { driverId: driver.id },
    );
  }
  if (driver.insuranceExpiresAt !== null) {
    // `insuranceExpiresAt` is a `date` column — compare YYYY-MM-DD
    // lexicographically against today UTC. We treat "expires today" as
    // valid (the policy is in force through end-of-day local time);
    // strict `<` is the boundary.
    const todayIso = now.toISOString().slice(0, 10);
    if (driver.insuranceExpiresAt < todayIso) {
      throw new DriverError('DRIVER_INSURANCE_EXPIRED', 'driver insurance has lapsed', {
        driverId: driver.id,
        insuranceExpiresAt: driver.insuranceExpiresAt,
      });
    }
  }
}

// Internal helper export used by service tests to validate the helper
// directly without going through the public API surface.
export { assertOnboardingComplete as __assertOnboardingComplete };

// Internal export so the controller tests can assert that the response
// for `status` carries the latest projection (not just a snapshot of
// the guard-attached context).
export type { DriverShift };
