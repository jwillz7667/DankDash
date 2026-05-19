import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
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
import { type DriverStatus, type OfferStatus } from '../schema/enums.js';
import { parsePoint, pointToSql } from '../schema/geo.js';
import { BaseRepository, newId } from './base.js';

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

  async updateLocation(id: string, location: GeoPoint): Promise<void> {
    const now = new Date();
    await this.db
      .update(drivers)
      .set({
        currentLocation: pointToSql(location),
        currentLocationUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(drivers.id, id));
  }

  async incrementDeliveryCount(id: string): Promise<void> {
    await this.db
      .update(drivers)
      .set({ totalDeliveries: sql`${drivers.totalDeliveries} + 1`, updatedAt: new Date() })
      .where(eq(drivers.id, id));
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
}
