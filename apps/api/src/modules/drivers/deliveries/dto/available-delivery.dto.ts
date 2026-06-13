/**
 * DTOs for the open-pool delivery surface (driver-facing):
 *
 *   GET  /v1/driver/deliveries/available       — claimable ready orders
 *   POST /v1/driver/deliveries/:orderId/claim  — first-come claim
 *
 * An "available delivery" is one order parked in `awaiting_driver` whose
 * dispensary is within the dispatch radius of the requesting driver. The
 * payload carries everything the dasher map needs to draw the pickup pin
 * (`pickup` + `pickupName`), the floating tip (`tipCents`), and — on tap
 * — the dispensary→dropoff route (`pickup`/`dropoff`), without a second
 * round-trip. Coordinates are WGS84 decimal degrees.
 *
 * The claim response is intentionally minimal: the order id plus its new
 * status (`driver_assigned`). The dasher app routes to its active-route
 * screen off `orderId`; it re-fetches the full order detail there.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GeoCoordinateSchema = z
  .object({
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
  })
  .strict();
export type GeoCoordinate = z.infer<typeof GeoCoordinateSchema>;

export const AvailableDeliverySchema = z
  .object({
    orderId: z.string().uuid(),
    shortCode: z.string(),
    dispensaryId: z.string().uuid(),
    pickupName: z.string(),
    pickup: GeoCoordinateSchema,
    dropoff: GeoCoordinateSchema,
    tipCents: z.number().int().min(0),
    totalCents: z.number().int().min(0),
    distanceMeters: z.number().min(0),
    awaitingDriverAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type AvailableDelivery = z.infer<typeof AvailableDeliverySchema>;
export class AvailableDeliveryDto extends createZodDto(AvailableDeliverySchema) {}

/**
 * `GET /v1/driver/deliveries/available` response. Wrapped in a
 * `{ deliveries }` envelope (not a bare array) so a future page-cursor
 * is non-breaking — the iOS `AvailableDeliveriesResponseDTO` decodes the
 * same envelope. Ordered nearest-pickup-first.
 */
export const AvailableDeliveriesResponseSchema = z
  .object({
    deliveries: z.array(AvailableDeliverySchema),
  })
  .strict();
export type AvailableDeliveriesResponse = z.infer<typeof AvailableDeliveriesResponseSchema>;
export class AvailableDeliveriesResponseDto extends createZodDto(
  AvailableDeliveriesResponseSchema,
) {}

export const ClaimDeliveryResponseSchema = z
  .object({
    orderId: z.string().uuid(),
    status: z.string(),
  })
  .strict();
export type ClaimDeliveryResponse = z.infer<typeof ClaimDeliveryResponseSchema>;
export class ClaimDeliveryResponseDto extends createZodDto(ClaimDeliveryResponseSchema) {}
