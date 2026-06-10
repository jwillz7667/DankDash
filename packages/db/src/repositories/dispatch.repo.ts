import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { type GeoPoint } from '../schema/custom-types.js';
import {
  dispatchOffers,
  driverLocationHistory,
  driverShifts,
  drivers,
  type DispatchOffer,
  type Driver,
  type DriverLocationHistoryRow,
  type DriverShift,
  type NewDispatchOffer,
  type NewDriver,
  type NewDriverLocationHistoryRow,
  type NewDriverShift,
} from '../schema/dispatch.js';
import { dispensaries } from '../schema/dispensaries.js';
import { type DriverStatus, type OfferStatus } from '../schema/enums.js';
import { parsePoint, pointToSql } from '../schema/geo.js';
import { orders } from '../schema/orders.js';
import { BaseRepository, newId } from './base.js';

/**
 * Row shape returned by the dispatch-candidate query — exactly the
 * fields `@dankdash/dispatch` needs for its `DispatchCandidate`
 * interface, plus the raw distance from the dispensary so the
 * scorer can normalise it. Kept narrow so we don't drag the full
 * Driver row (and its parsed GeoPoint location) through the
 * candidate scan.
 */
export interface DispatchCandidateRow {
  readonly driverId: string;
  readonly distanceMeters: number;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  readonly lastDeliveryAt: Date | null;
}

interface DriverRow extends Omit<Driver, 'currentLocation'> {
  readonly currentLocation: string | null;
}

interface DriverShiftRow extends Omit<DriverShift, 'startingLocation' | 'endingLocation'> {
  readonly startingLocation: string | null;
  readonly endingLocation: string | null;
}

interface DriverLocationHistoryDbRow extends Omit<DriverLocationHistoryRow, 'location'> {
  readonly location: string;
}

const CURRENT_LOCATION_SQL = sql<
  string | null
>`CASE WHEN ${drivers.currentLocation} IS NULL THEN NULL ELSE ST_AsGeoJSON(${drivers.currentLocation}) END`;

const SHIFT_START_SQL = sql<
  string | null
>`CASE WHEN ${driverShifts.startingLocation} IS NULL THEN NULL ELSE ST_AsGeoJSON(${driverShifts.startingLocation}) END`;

const SHIFT_END_SQL = sql<
  string | null
>`CASE WHEN ${driverShifts.endingLocation} IS NULL THEN NULL ELSE ST_AsGeoJSON(${driverShifts.endingLocation}) END`;

const LOCATION_HISTORY_SQL = sql<string>`ST_AsGeoJSON(${driverLocationHistory.location})`;

const SHIFT_COLUMNS = {
  id: driverShifts.id,
  driverId: driverShifts.driverId,
  startedAt: driverShifts.startedAt,
  endedAt: driverShifts.endedAt,
  startingLocation: SHIFT_START_SQL,
  endingLocation: SHIFT_END_SQL,
  totalMiles: driverShifts.totalMiles,
  totalDeliveries: driverShifts.totalDeliveries,
  totalEarningsCents: driverShifts.totalEarningsCents,
} as const;

const LOCATION_HISTORY_COLUMNS = {
  id: driverLocationHistory.id,
  driverId: driverLocationHistory.driverId,
  orderId: driverLocationHistory.orderId,
  location: LOCATION_HISTORY_SQL,
  accuracyMeters: driverLocationHistory.accuracyMeters,
  speedMps: driverLocationHistory.speedMps,
  headingDeg: driverLocationHistory.headingDeg,
  batteryPct: driverLocationHistory.batteryPct,
  recordedAt: driverLocationHistory.recordedAt,
} as const;

function inflateShift(row: DriverShiftRow): DriverShift {
  return {
    ...row,
    startingLocation: row.startingLocation === null ? null : parsePoint(row.startingLocation),
    endingLocation: row.endingLocation === null ? null : parsePoint(row.endingLocation),
  };
}

function inflateLocationHistory(row: DriverLocationHistoryDbRow): DriverLocationHistoryRow {
  return { ...row, location: parsePoint(row.location) };
}

const DRIVER_COLUMNS = {
  id: drivers.id,
  userId: drivers.userId,
  licenseNumberHash: drivers.licenseNumberHash,
  vehicleMake: drivers.vehicleMake,
  vehicleModel: drivers.vehicleModel,
  vehicleYear: drivers.vehicleYear,
  vehiclePlate: drivers.vehiclePlate,
  vehicleColor: drivers.vehicleColor,
  insuranceDocKey: drivers.insuranceDocKey,
  insuranceExpiresAt: drivers.insuranceExpiresAt,
  backgroundCheckPassedAt: drivers.backgroundCheckPassedAt,
  backgroundCheckProviderRef: drivers.backgroundCheckProviderRef,
  currentStatus: drivers.currentStatus,
  lastStatusChangeAt: drivers.lastStatusChangeAt,
  currentLocation: CURRENT_LOCATION_SQL,
  currentLocationUpdatedAt: drivers.currentLocationUpdatedAt,
  currentOrderId: drivers.currentOrderId,
  ratingAvg: drivers.ratingAvg,
  ratingCount: drivers.ratingCount,
  totalDeliveries: drivers.totalDeliveries,
  createdAt: drivers.createdAt,
  updatedAt: drivers.updatedAt,
} as const;

function inflateDriver(row: DriverRow): Driver {
  return {
    ...row,
    currentLocation: row.currentLocation === null ? null : parsePoint(row.currentLocation),
  };
}

export class DriversRepository extends BaseRepository {
  async findById(id: string): Promise<Driver | null> {
    const [row] = await this.db
      .select(DRIVER_COLUMNS)
      .from(drivers)
      .where(eq(drivers.id, id))
      .limit(1);
    return row === undefined ? null : inflateDriver(row);
  }

  async findByUserId(userId: string): Promise<Driver | null> {
    const [row] = await this.db
      .select(DRIVER_COLUMNS)
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);
    return row === undefined ? null : inflateDriver(row);
  }

  /**
   * `SELECT … FOR UPDATE` on a drivers row. Must run inside a
   * transaction (Postgres rejects FOR UPDATE on an autocommitted
   * statement) — callers serialise around the lock so concurrent
   * shift-start / shift-end / offer-accept paths cannot interleave on
   * the same driver. Returns `null` if no row exists; callers map that
   * to whatever domain error fits (DriverError NOT_FOUND, etc.).
   */
  async findByIdForUpdate(id: string): Promise<Driver | null> {
    const [row] = await this.db
      .select(DRIVER_COLUMNS)
      .from(drivers)
      .where(eq(drivers.id, id))
      .for('update')
      .limit(1);
    return row === undefined ? null : inflateDriver(row);
  }

  async listOnline(): Promise<readonly Driver[]> {
    const rows = await this.db
      .select(DRIVER_COLUMNS)
      .from(drivers)
      .where(eq(drivers.currentStatus, 'online'));
    return rows.map((row) => inflateDriver(row));
  }

  async create(input: Omit<NewDriver, 'id'> & { readonly id?: string }): Promise<Driver> {
    const id = input.id ?? newId();
    const [inserted] = await this.db
      .insert(drivers)
      .values({ ...input, id })
      .returning({ id: drivers.id });
    if (inserted === undefined) throw new RepositoryError('drivers insert returned no row');
    const row = await this.findById(inserted.id);
    if (row === null) throw new RepositoryError(`drivers ${inserted.id} disappeared after insert`);
    return row;
  }

  /**
   * Patch updatable columns on a drivers row. Identity (userId,
   * licenseNumberHash) and status fields (currentStatus, currentOrderId,
   * currentLocation) are deliberately excluded — those flow through
   * setStatus/setCurrentOrder/updateLocation so the lifecycle invariants
   * stay in one place.
   */
  async update(
    id: string,
    patch: Partial<
      Omit<
        NewDriver,
        | 'id'
        | 'userId'
        | 'licenseNumberHash'
        | 'currentStatus'
        | 'currentOrderId'
        | 'currentLocation'
        | 'currentLocationUpdatedAt'
        | 'lastStatusChangeAt'
        | 'createdAt'
        | 'ratingAvg'
        | 'ratingCount'
        | 'totalDeliveries'
      >
    >,
  ): Promise<Driver | null> {
    const [updated] = await this.db
      .update(drivers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(drivers.id, id))
      .returning({ id: drivers.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  async setStatus(id: string, status: DriverStatus): Promise<void> {
    const now = new Date();
    await this.db
      .update(drivers)
      .set({ currentStatus: status, lastStatusChangeAt: now, updatedAt: now })
      .where(eq(drivers.id, id));
  }

  async setCurrentOrder(id: string, orderId: string | null): Promise<void> {
    await this.db
      .update(drivers)
      .set({ currentOrderId: orderId, updatedAt: new Date() })
      .where(eq(drivers.id, id));
  }

  /**
   * Patch `currentLocation` + `currentLocationUpdatedAt` for one driver.
   *
   * `recordedAt` is the timestamp the *event* claims — when omitted, the
   * wall clock is used (shift start/end, manual ops actions). The location
   * ingest worker passes the ping's `recordedAt` so the row reflects the
   * actual freshness of the location, not the latency it took to drain the
   * Redis Stream.
   *
   * Out-of-order writes are dropped via a `WHERE` guard rather than an
   * application-side compare-and-swap loop. At-least-once delivery on the
   * realtime stream means the worker can re-process an entry that was
   * already applied (claim recovery > recoverIdleMs) — in that case the
   * write must be a no-op so a stale point does not overwrite a fresher
   * one. The guard is `current_location_updated_at IS NULL OR
   * current_location_updated_at < recordedAt`; equal timestamps lose the
   * tie because the existing row's data is at least as good.
   */
  async updateLocation(id: string, location: GeoPoint, recordedAt?: Date): Promise<void> {
    const now = new Date();
    const stamp = recordedAt ?? now;
    await this.db
      .update(drivers)
      .set({
        currentLocation: pointToSql(location),
        currentLocationUpdatedAt: stamp,
        updatedAt: now,
      })
      .where(
        and(
          eq(drivers.id, id),
          or(isNull(drivers.currentLocationUpdatedAt), lt(drivers.currentLocationUpdatedAt, stamp)),
        ),
      );
  }

  async incrementDeliveryCount(id: string): Promise<void> {
    await this.db
      .update(drivers)
      .set({ totalDeliveries: sql`${drivers.totalDeliveries} + 1`, updatedAt: new Date() })
      .where(eq(drivers.id, id));
  }

  /**
   * Find online drivers within `maxRadiusMeters` of the dispensary,
   * with their beeline distance and last-delivery timestamp attached.
   * Used by the dispatch worker — the worker hands the rows straight
   * to `@dankdash/dispatch`'s scoring layer.
   *
   * Eligibility filter (in addition to radius):
   *   - `current_status = 'online'` (not offline, on_break, unavailable)
   *   - `current_order_id IS NULL` (not already mid-delivery)
   *   - has a `current_location` set (cannot route a driver we cannot find)
   *
   * Distance uses `ST_Distance` on the geography type — returned in
   * meters, no projection conversion needed. The radius filter is
   * `ST_DWithin` so PostgreSQL can use the GiST index on
   * `drivers.current_location` instead of computing distance for every
   * online driver.
   *
   * `lastDeliveryAt` is a correlated subquery against `orders` —
   * cheaper than a LEFT JOIN + GROUP BY at the candidate-pool sizes
   * we expect (dozens of drivers per dispensary). If we ever scale to
   * thousands of drivers per ping we should denormalise this onto
   * `drivers.last_delivery_at`, but that's a future-day problem.
   */
  async findDispatchCandidatesNearDispensary(
    dispensaryId: string,
    maxRadiusMeters: number,
  ): Promise<readonly DispatchCandidateRow[]> {
    const distanceSql = sql<string>`ST_Distance(${drivers.currentLocation}, ${dispensaries.location})`;
    const lastDeliveryAtSql = sql<Date | null>`(SELECT MAX(${orders.deliveredAt}) FROM ${orders} WHERE ${orders.driverId} = ${drivers.userId})`;

    const rows = await this.db
      .select({
        driverId: drivers.id,
        distanceMeters: distanceSql,
        ratingAvg: drivers.ratingAvg,
        ratingCount: drivers.ratingCount,
        lastDeliveryAt: lastDeliveryAtSql,
      })
      .from(drivers)
      .innerJoin(dispensaries, eq(dispensaries.id, dispensaryId))
      .where(
        and(
          eq(drivers.currentStatus, 'online'),
          isNull(drivers.currentOrderId),
          sql`${drivers.currentLocation} IS NOT NULL`,
          sql`ST_DWithin(${drivers.currentLocation}, ${dispensaries.location}, ${maxRadiusMeters})`,
        ),
      );

    return rows.map((row) => ({
      driverId: row.driverId,
      // Drizzle returns geography distances as `string` (Postgres NUMERIC).
      // Coerce here so the scorer never sees a string masquerading as a
      // number — JavaScript would happily compare them and silently bias
      // the rank.
      distanceMeters: Number(row.distanceMeters),
      ratingAvg: row.ratingAvg === null ? null : Number(row.ratingAvg),
      ratingCount: row.ratingCount,
      lastDeliveryAt: row.lastDeliveryAt,
    }));
  }
}

export class DriverShiftsRepository extends BaseRepository {
  async findActiveForDriver(driverId: string): Promise<DriverShift | null> {
    const [row] = await this.db
      .select(SHIFT_COLUMNS)
      .from(driverShifts)
      .where(and(eq(driverShifts.driverId, driverId), isNull(driverShifts.endedAt)))
      .orderBy(desc(driverShifts.startedAt))
      .limit(1);
    return row === undefined ? null : inflateShift(row);
  }

  async listForDriver(driverId: string, limit = 50): Promise<readonly DriverShift[]> {
    const rows = await this.db
      .select(SHIFT_COLUMNS)
      .from(driverShifts)
      .where(eq(driverShifts.driverId, driverId))
      .orderBy(desc(driverShifts.startedAt))
      .limit(limit);
    return rows.map((row) => inflateShift(row));
  }

  async start(
    driverId: string,
    startingLocation: GeoPoint,
    startedAt = new Date(),
  ): Promise<DriverShift> {
    const id = newId();
    const [inserted] = await this.db
      .insert(driverShifts)
      .values({
        id,
        driverId,
        startedAt,
        startingLocation: pointToSql(startingLocation) as unknown as never,
      } satisfies NewDriverShift)
      .returning({ id: driverShifts.id });
    if (inserted === undefined) throw new RepositoryError('driver_shifts insert returned no row');
    const row = await this.findById(inserted.id);
    if (row === null)
      throw new RepositoryError(`driver_shifts ${inserted.id} disappeared after insert`);
    return row;
  }

  async end(
    id: string,
    endingLocation: GeoPoint,
    endedAt = new Date(),
  ): Promise<DriverShift | null> {
    const [updated] = await this.db
      .update(driverShifts)
      .set({
        endedAt,
        endingLocation: pointToSql(endingLocation),
      })
      .where(eq(driverShifts.id, id))
      .returning({ id: driverShifts.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  async findById(id: string): Promise<DriverShift | null> {
    const [row] = await this.db
      .select(SHIFT_COLUMNS)
      .from(driverShifts)
      .where(eq(driverShifts.id, id))
      .limit(1);
    return row === undefined ? null : inflateShift(row);
  }

  async recordDelivery(id: string, earningsCents: number): Promise<void> {
    await this.db
      .update(driverShifts)
      .set({
        totalDeliveries: sql`${driverShifts.totalDeliveries} + 1`,
        totalEarningsCents: sql`${driverShifts.totalEarningsCents} + ${earningsCents}`,
      })
      .where(eq(driverShifts.id, id));
  }
}

/**
 * Append-only repository — `driver_location_history` is the hottest write
 * path in the system (location pings ~every 5s per active driver) and is
 * partitioned weekly. No updates or deletes; reads paginate by `recorded_at`.
 */
export class DriverLocationHistoryRepository extends BaseRepository {
  async record(
    input: Omit<NewDriverLocationHistoryRow, 'id' | 'location'> & {
      readonly location: GeoPoint;
    },
  ): Promise<void> {
    const { location, ...rest } = input;
    await this.db.insert(driverLocationHistory).values({
      ...rest,
      location: pointToSql(location),
    });
  }

  async recordBatch(
    inputs: readonly (Omit<NewDriverLocationHistoryRow, 'id' | 'location'> & {
      readonly location: GeoPoint;
    })[],
  ): Promise<void> {
    if (inputs.length === 0) return;
    const values = inputs.map(({ location, ...rest }) => ({
      ...rest,
      location: pointToSql(location) as unknown as never,
    }));
    await this.db.insert(driverLocationHistory).values(values);
  }

  async latestForOrder(orderId: string, limit = 200): Promise<readonly DriverLocationHistoryRow[]> {
    const rows = await this.db
      .select(LOCATION_HISTORY_COLUMNS)
      .from(driverLocationHistory)
      .where(eq(driverLocationHistory.orderId, orderId))
      .orderBy(desc(driverLocationHistory.recordedAt))
      .limit(limit);
    return rows.map((row) => inflateLocationHistory(row));
  }
}

export class DispatchOffersRepository extends BaseRepository {
  async findById(id: string): Promise<DispatchOffer | null> {
    const [row] = await this.db
      .select()
      .from(dispatchOffers)
      .where(eq(dispatchOffers.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * `SELECT … FOR UPDATE` on a dispatch_offers row. Must run inside a
   * transaction. Used by the driver accept/decline path so a second
   * concurrent accept on the same offer blocks behind the lock and
   * fails the "already responded" status check after the first wins.
   *
   * `respond()`'s atomic `WHERE status = 'offered'` already serialises
   * accept races at the SQL level — the FOR UPDATE here is additional
   * defence so the entire accept flow (offer validate + driver lock +
   * order transition) sees a stable offer snapshot for the lifetime of
   * the tx.
   */
  async findByIdForUpdate(id: string): Promise<DispatchOffer | null> {
    const [row] = await this.db
      .select()
      .from(dispatchOffers)
      .where(eq(dispatchOffers.id, id))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  async listActiveForDriver(driverId: string, now: Date): Promise<readonly DispatchOffer[]> {
    return this.db
      .select()
      .from(dispatchOffers)
      .where(
        and(
          eq(dispatchOffers.driverId, driverId),
          eq(dispatchOffers.status, 'offered'),
          gt(dispatchOffers.expiresAt, now),
        ),
      )
      .orderBy(desc(dispatchOffers.offeredAt));
  }

  async listForOrder(orderId: string): Promise<readonly DispatchOffer[]> {
    return this.db
      .select()
      .from(dispatchOffers)
      .where(eq(dispatchOffers.orderId, orderId))
      .orderBy(desc(dispatchOffers.offeredAt));
  }

  async create(
    input: Omit<NewDispatchOffer, 'id'> & { readonly id?: string },
  ): Promise<DispatchOffer> {
    const [row] = await this.db
      .insert(dispatchOffers)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('dispatch_offers insert returned no row');
    return row;
  }

  async respond(
    id: string,
    status: Exclude<OfferStatus, 'offered'>,
    respondedAt: Date,
    declineReason?: string,
  ): Promise<DispatchOffer | null> {
    const [row] = await this.db
      .update(dispatchOffers)
      .set({ status, respondedAt, declineReason: declineReason ?? null })
      .where(and(eq(dispatchOffers.id, id), eq(dispatchOffers.status, 'offered')))
      .returning();
    return row ?? null;
  }

  /**
   * Flip a driver's `accepted` offer back out of `accepted` when they
   * cancel the delivery before pickup (DRIVER_CANCELED). The dispatch
   * orchestrator treats any `accepted` history row as "attempt done,
   * never re-offer" — leaving the row in place would strand the order
   * in `awaiting_driver` forever. The DB enum has no 'canceled' value,
   * so we reuse 'declined': it carries the same re-offer semantics
   * (this driver is excluded from the retry round) and the
   * `decline_reason` distinguishes a post-accept bail from a plain
   * decline for ops. Conditional on `status = 'accepted'` so a racing
   * second cancel is a no-op (returns null).
   */
  async releaseAcceptedForOrder(
    orderId: string,
    driverId: string,
    now: Date,
    reason: string,
  ): Promise<DispatchOffer | null> {
    const [row] = await this.db
      .update(dispatchOffers)
      .set({ status: 'declined', respondedAt: now, declineReason: reason })
      .where(
        and(
          eq(dispatchOffers.orderId, orderId),
          eq(dispatchOffers.driverId, driverId),
          eq(dispatchOffers.status, 'accepted'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Bulk-expire offers whose `expires_at` has passed without a response. Run
   * by a scheduled job — returns the count of expired offers for telemetry.
   */
  async expireStale(now: Date): Promise<number> {
    const rows = await this.db
      .update(dispatchOffers)
      .set({ status: 'expired', respondedAt: now })
      .where(and(eq(dispatchOffers.status, 'offered'), lte(dispatchOffers.expiresAt, now)))
      .returning({ id: dispatchOffers.id });
    return rows.length;
  }

  /**
   * When one offer for an order is accepted, every other still-`offered`
   * sibling on the same order is effectively dead — the driver who would
   * have responded to them has lost the race. Flip them to `expired` so:
   *   - the partial index `dispatch_offers_active_idx` (status='offered')
   *     drops them immediately
   *   - the driver's app stops showing them in "my live offers"
   *   - the audit row carries `respondedAt = now` (the timestamp at which
   *     they were superseded), not the eventual cron expiry
   *
   * The DB enum doesn't carry a 'superseded' value, so we reuse 'expired'.
   * Callers that need to distinguish "timed out" from "lost race" can
   * inspect `responded_at` vs. `expires_at`: if `responded_at < expires_at`
   * the row was cancelled early, otherwise it timed out.
   */
  async expireOtherActiveForOrder(
    orderId: string,
    keepOfferId: string,
    now: Date,
  ): Promise<number> {
    const rows = await this.db
      .update(dispatchOffers)
      .set({ status: 'expired', respondedAt: now })
      .where(
        and(
          eq(dispatchOffers.orderId, orderId),
          eq(dispatchOffers.status, 'offered'),
          sql`${dispatchOffers.id} <> ${keepOfferId}`,
        ),
      )
      .returning({ id: dispatchOffers.id });
    return rows.length;
  }
}
