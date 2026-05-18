import { sql } from 'drizzle-orm';
import {
  bigserial,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, geographyPoint, type GeoPoint } from './custom-types.js';
import { driverStatus, offerStatus } from './enums.js';
import { users } from './identity.js';
import { orders } from './orders.js';

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    licenseNumberHash: bytea('license_number_hash').notNull(),
    vehicleMake: text('vehicle_make'),
    vehicleModel: text('vehicle_model'),
    vehicleYear: integer('vehicle_year'),
    vehiclePlate: text('vehicle_plate'),
    vehicleColor: text('vehicle_color'),
    insuranceDocKey: text('insurance_doc_key'),
    insuranceExpiresAt: date('insurance_expires_at'),
    backgroundCheckPassedAt: date('background_check_passed_at'),
    backgroundCheckProviderRef: text('background_check_provider_ref'),
    currentStatus: driverStatus('current_status').notNull().default('offline'),
    lastStatusChangeAt: timestamp('last_status_change_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    currentLocation: geographyPoint('current_location'),
    currentLocationUpdatedAt: timestamp('current_location_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    currentOrderId: uuid('current_order_id').references(() => orders.id),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    totalDeliveries: integer('total_deliveries').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Spatial partial index on current_location WHERE status='online' is emitted
    // from raw migration SQL (PostGIS GIST).
    index('drivers_current_order_idx')
      .on(table.currentOrderId)
      .where(sql`${table.currentOrderId} IS NOT NULL`),
  ],
);

export const driverShifts = pgTable(
  'driver_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    startingLocation: geographyPoint('starting_location'),
    endingLocation: geographyPoint('ending_location'),
    totalMiles: numeric('total_miles', { precision: 8, scale: 2 }),
    totalDeliveries: integer('total_deliveries').notNull().default(0),
    totalEarningsCents: integer('total_earnings_cents').notNull().default(0),
  },
  (table) => [
    index('driver_shifts_driver_idx').on(table.driverId, table.startedAt),
    index('driver_shifts_active_idx')
      .on(table.driverId)
      .where(sql`${table.endedAt} IS NULL`),
  ],
);

/**
 * High-volume hot table — declarative range partition by week on
 * `recorded_at`. Defined in raw migration SQL because Drizzle does not
 * emit PARTITION BY clauses; this export carries the column shape.
 *
 * Primary key is `(id, recorded_at)` (Postgres requirement for partitioned
 * unique constraints). `id` is `bigserial` for cheap ordering on insert.
 */
export const driverLocationHistory = pgTable(
  'driver_location_history',
  {
    id: bigserial('id', { mode: 'bigint' }),
    driverId: uuid('driver_id').notNull(),
    orderId: uuid('order_id'),
    location: geographyPoint('location').notNull(),
    accuracyMeters: numeric('accuracy_meters', { precision: 8, scale: 2 }),
    speedMps: numeric('speed_mps', { precision: 6, scale: 2 }),
    headingDeg: numeric('heading_deg', { precision: 5, scale: 2 }),
    batteryPct: smallint('battery_pct'),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  () => [
    // PK and partition declared in raw migration SQL.
  ],
);

export const dispatchOffers = pgTable(
  'dispatch_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    payoutEstimateCents: integer('payout_estimate_cents').notNull(),
    distanceMiles: numeric('distance_miles', { precision: 6, scale: 2 }).notNull(),
    status: offerStatus('status').notNull().default('offered'),
    respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
    declineReason: text('decline_reason'),
  },
  (table) => [
    index('dispatch_offers_order_idx').on(table.orderId),
    index('dispatch_offers_driver_idx').on(table.driverId, table.offeredAt),
    index('dispatch_offers_active_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'offered'`),
  ],
);

type DriverDbRow = typeof drivers.$inferSelect;
/** Public driver shape — `currentLocation` parsed from `ST_AsGeoJSON`. */
export type Driver = Omit<DriverDbRow, 'currentLocation'> & {
  readonly currentLocation: GeoPoint | null;
};
export type NewDriver = typeof drivers.$inferInsert;

type DriverShiftDbRow = typeof driverShifts.$inferSelect;
/** Public shift shape — start/end locations parsed from `ST_AsGeoJSON`. */
export type DriverShift = Omit<DriverShiftDbRow, 'startingLocation' | 'endingLocation'> & {
  readonly startingLocation: GeoPoint | null;
  readonly endingLocation: GeoPoint | null;
};
export type NewDriverShift = typeof driverShifts.$inferInsert;

type DriverLocationHistoryDbRow = typeof driverLocationHistory.$inferSelect;
/** Public location-history shape — `location` parsed from `ST_AsGeoJSON`. */
export type DriverLocationHistoryRow = Omit<DriverLocationHistoryDbRow, 'location'> & {
  readonly location: GeoPoint;
};
export type NewDriverLocationHistoryRow = typeof driverLocationHistory.$inferInsert;

export type DispatchOffer = typeof dispatchOffers.$inferSelect;
export type NewDispatchOffer = typeof dispatchOffers.$inferInsert;
