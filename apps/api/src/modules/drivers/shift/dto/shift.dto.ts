/**
 * DTOs for the driver-self shift surface (Phase 8.2):
 *
 *   POST /v1/driver/shift/start   { startingLocation }
 *   POST /v1/driver/shift/end     { endingLocation }
 *   POST /v1/driver/status        { status }
 *
 * Shift requests carry a GeoJSON Point — same wire shape used for the
 * dispensary feed so client code already has one parser. Coordinates are
 * `[lng, lat]` WGS84 per RFC 7946; the lat range is the tight 21–50 box
 * that covers the contiguous US so a swapped pair is caught at the edge
 * instead of in the dispatch scorer.
 *
 * `UpdateDriverStatusRequestSchema` only admits the three statuses a
 * driver can actually self-set — `online`, `on_break`, `unavailable`.
 * `offline` is reachable only via `POST /v1/driver/shift/end` because
 * ending the shift also closes the shift row + ending-location ping.
 * `en_route_pickup` and `en_route_dropoff` are reserved for the order
 * state machine (accept/pickup) and are explicitly rejected here.
 *
 * `DriverShiftResponseSchema` mirrors `driver_shifts` 1:1 minus the
 * `totalMiles`/`totalEarningsCents` aggregates being string/integer at
 * the wire (NUMERIC arrives as string from pg, integer cents as number).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { GeoPointSchema } from '../../../dispensaries/dto/dispensary.dto.js';

const Longitude = z.number().gte(-180).lte(180);
const Latitude = z.number().gte(-90).lte(90);

/**
 * Sanity-checked GeoJSON Point used in shift bodies. The outer
 * `GeoPointSchema` already enforces the `{ type: 'Point', coordinates:
 * [number, number] }` shape; we additionally clamp each component to
 * its valid range so a transposed lat/lng pair fails validation at the
 * boundary instead of producing a nonsense PostGIS row.
 */
const BoundedGeoPointSchema = GeoPointSchema.superRefine((point, ctx) => {
  const [lng, lat] = point.coordinates;
  if (!Longitude.safeParse(lng).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['coordinates', 0],
      message: 'longitude must be in [-180, 180]',
    });
  }
  if (!Latitude.safeParse(lat).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['coordinates', 1],
      message: 'latitude must be in [-90, 90]',
    });
  }
});

export const StartShiftRequestSchema = z
  .object({
    startingLocation: BoundedGeoPointSchema,
  })
  .strict();
export type StartShiftRequest = z.infer<typeof StartShiftRequestSchema>;
export class StartShiftRequestDto extends createZodDto(StartShiftRequestSchema) {}

export const EndShiftRequestSchema = z
  .object({
    endingLocation: BoundedGeoPointSchema,
  })
  .strict();
export type EndShiftRequest = z.infer<typeof EndShiftRequestSchema>;
export class EndShiftRequestDto extends createZodDto(EndShiftRequestSchema) {}

/**
 * Statuses a driver may self-set via POST /v1/driver/status.
 *
 *   - `online`       — return to the dispatch pool from break/unavailable
 *   - `on_break`     — temporary unavailability, recoverable
 *   - `unavailable`  — soft unavailability (e.g. low battery, eating)
 *
 * `offline` is intentionally excluded: ending availability also ends
 * the shift, and the shift row needs a closing location, which this
 * endpoint does not carry. `en_route_pickup` / `en_route_dropoff` are
 * machine-driven (set by the offer-accept handler / pickup handler);
 * a self-set would create a phantom assignment.
 */
export const SelfSettableDriverStatusSchema = z.enum(['online', 'on_break', 'unavailable']);
export type SelfSettableDriverStatus = z.infer<typeof SelfSettableDriverStatusSchema>;

export const UpdateDriverStatusRequestSchema = z
  .object({
    status: SelfSettableDriverStatusSchema,
  })
  .strict();
export type UpdateDriverStatusRequest = z.infer<typeof UpdateDriverStatusRequestSchema>;
export class UpdateDriverStatusRequestDto extends createZodDto(UpdateDriverStatusRequestSchema) {}

export const DriverShiftResponseSchema = z
  .object({
    id: z.string().uuid(),
    driverId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    startingLocation: GeoPointSchema.nullable(),
    endingLocation: GeoPointSchema.nullable(),
    totalMiles: z.string().nullable(),
    totalDeliveries: z.number().int().min(0),
    totalEarningsCents: z.number().int().min(0),
  })
  .strict();
export type DriverShiftResponse = z.infer<typeof DriverShiftResponseSchema>;
export class DriverShiftResponseDto extends createZodDto(DriverShiftResponseSchema) {}
