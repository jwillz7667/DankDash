/**
 * Single source of truth for turning a `@dankdash/db` Driver row into the
 * `DriverResponse` wire shape. Strips the license number hash (clients
 * never see it), renders all timestamps as ISO-8601 with offset, and
 * passes the GeoJSON point through unchanged.
 *
 * `ratingAvg` stays a string because Postgres `numeric(3,2)` round-trips
 * as a string through `pg`/Drizzle; converting to JS `number` would
 * silently lose precision on values like `4.95` near the column's
 * resolution. Clients render it as-is.
 */
import type { DriverResponse } from './dto/index.js';
import type { Driver } from '@dankdash/db';

export function projectDriver(row: Driver): DriverResponse {
  return {
    id: row.id,
    userId: row.userId,
    vehicleMake: row.vehicleMake,
    vehicleModel: row.vehicleModel,
    vehicleYear: row.vehicleYear,
    vehiclePlate: row.vehiclePlate,
    vehicleColor: row.vehicleColor,
    insuranceDocKey: row.insuranceDocKey,
    insuranceExpiresAt: row.insuranceExpiresAt,
    backgroundCheckPassedAt: row.backgroundCheckPassedAt,
    backgroundCheckProviderRef: row.backgroundCheckProviderRef,
    currentStatus: row.currentStatus,
    lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
    currentLocation: row.currentLocation,
    currentLocationUpdatedAt:
      row.currentLocationUpdatedAt === null ? null : row.currentLocationUpdatedAt.toISOString(),
    currentOrderId: row.currentOrderId,
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    totalDeliveries: row.totalDeliveries,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
