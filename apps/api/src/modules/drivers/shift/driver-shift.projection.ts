/**
 * `driver_shifts` row → `DriverShiftResponse` projection.
 *
 * Single source of truth for shift serialisation. The DB row carries
 * `Date` objects, the wire format carries ISO-8601 strings with offset
 * (so a JS client `new Date(s)` round-trips losslessly). `totalMiles`
 * arrives from pg as a `NUMERIC` string — kept as-is at the wire so
 * float-rounding doesn't introduce drift in mileage display.
 */
import { type DriverShift } from '@dankdash/db';
import { type DriverShiftResponse } from './dto/index.js';

export function projectDriverShift(row: DriverShift): DriverShiftResponse {
  return {
    id: row.id,
    driverId: row.driverId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
    startingLocation: row.startingLocation,
    endingLocation: row.endingLocation,
    totalMiles: row.totalMiles,
    totalDeliveries: row.totalDeliveries,
    totalEarningsCents: row.totalEarningsCents,
  };
}
