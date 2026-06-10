/**
 * Request bodies for the driver's two write-side handoff endpoints:
 *
 *   POST /v1/driver/orders/:id/pickup-confirm
 *   POST /v1/driver/orders/:id/delivery-confirm
 *
 * Both endpoints carry the driver's current location at the moment of
 * the action. Two reasons:
 *
 *   - **Audit.** `order_events` is append-only — the captured coordinate
 *     proves where the driver claimed they were when they tapped the
 *     button. A future dispute (e.g. customer claiming the bag was
 *     never delivered) reads against this row.
 *
 *   - **Spec compliance.** Phase 20 §20.2 calls out "records location +
 *     timestamp" on pickup-confirm; delivery-confirm mirrors the shape.
 *
 * Location is optional at the request layer because the iOS client may
 * be denied background-location after the route concludes (the user
 * background-app-killed the app between Arrived and Delivery Complete).
 * The handoff still has to be recordable in that degenerate case —
 * `null` is preserved on the event row and surfaced to ops dashboards
 * so we can flag drivers with chronic location-denial as a coaching
 * signal.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Coordinate captured at the moment of the action. Latitude is bounded
 * to MN's lat range with slack — the wider bounds (-90, 90) just
 * reject obvious bug values without coupling the schema to geography
 * that's enforced elsewhere (geofence checks at checkout).
 *
 * `accuracyMeters` is the device's reported horizontal accuracy — large
 * values do not reject the request but get logged so a future analytics
 * pass can correlate dispute frequency with location-quality.
 *
 * `capturedAt` is when the device captured the fix, NOT when the
 * request hit the server. The two can drift by seconds on a flaky
 * cell connection; keeping the device clock value lets us reconstruct
 * the actual handoff timing later.
 */
export const DriverLocationFixSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().nonnegative().nullable(),
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DriverLocationFix = z.infer<typeof DriverLocationFixSchema>;

export const DriverPickupConfirmRequestSchema = z
  .object({
    location: DriverLocationFixSchema.nullable(),
  })
  .strict();

export type DriverPickupConfirmRequest = z.infer<typeof DriverPickupConfirmRequestSchema>;

export class DriverPickupConfirmRequestDto extends createZodDto(DriverPickupConfirmRequestSchema) {}

/**
 * POST /v1/driver/orders/:id/depart — `picked_up` → `en_route_dropoff`.
 * Driver has the bag and is leaving the dispensary for the customer.
 * Same location-fix audit shape as pickup-confirm: the captured
 * coordinate is the start-of-trip evidence on the append-only
 * `order_events` row.
 */
export const DriverDepartRequestSchema = z
  .object({
    location: DriverLocationFixSchema.nullable(),
  })
  .strict();

export type DriverDepartRequest = z.infer<typeof DriverDepartRequestSchema>;

export class DriverDepartRequestDto extends createZodDto(DriverDepartRequestSchema) {}

/**
 * POST /v1/driver/orders/:id/arrive — `en_route_dropoff` →
 * `arrived_at_dropoff`. Driver reached the customer's address; the next
 * legal step is the (non-bypassable) ID-scan session. The captured
 * coordinate proves arrival proximity for a future dispute.
 */
export const DriverArriveRequestSchema = z
  .object({
    location: DriverLocationFixSchema.nullable(),
  })
  .strict();

export type DriverArriveRequest = z.infer<typeof DriverArriveRequestSchema>;

export class DriverArriveRequestDto extends createZodDto(DriverArriveRequestSchema) {}

/**
 * POST /v1/driver/orders/:id/cancel — `driver_assigned` | `en_route_pickup`
 * → `awaiting_driver`. The driver backs out AFTER accepting the offer but
 * BEFORE taking custody of the product. The order goes back to dispatch
 * with a fresh attempt budget; the canceling driver's accepted offer is
 * released so the orchestrator re-offers to someone else, and the driver
 * returns to `online`. After `picked_up` this endpoint is illegal (422
 * from the state machine) — cannabis in the car can only complete the
 * delivery or go through the return-to-store flow.
 *
 * `reason` is the driver's free-text justification ("car trouble",
 * "store line too long"); preserved on the append-only `order_events`
 * payload for ops review — chronic cancelers are a coaching signal.
 */
export const DriverCancelDeliveryRequestSchema = z
  .object({
    location: DriverLocationFixSchema.nullable(),
    reason: z.string().max(280).nullable(),
  })
  .strict();

export type DriverCancelDeliveryRequest = z.infer<typeof DriverCancelDeliveryRequestSchema>;

export class DriverCancelDeliveryRequestDto extends createZodDto(
  DriverCancelDeliveryRequestSchema,
) {}

/**
 * Cancel response is intentionally minimal: after the transition the
 * order no longer belongs to this driver, so the full
 * DriverOrderDetailResponse hydration (which pairs orderId with the
 * driver in the WHERE) would 404 by construction.
 */
export interface DriverCancelDeliveryResponse {
  readonly orderId: string;
  readonly status: 'awaiting_driver';
}

export const DriverDeliveryConfirmRequestSchema = z
  .object({
    location: DriverLocationFixSchema.nullable(),
    /**
     * Optional driver-supplied free-text note from the dropoff card
     * (e.g. "Left with concierge", "Took photo at door"). 280 chars
     * cap so it fits in an iOS toast preview if the customer support
     * console later renders it inline.
     */
    notes: z.string().max(280).nullable(),
  })
  .strict();

export type DriverDeliveryConfirmRequest = z.infer<typeof DriverDeliveryConfirmRequestSchema>;

export class DriverDeliveryConfirmRequestDto extends createZodDto(
  DriverDeliveryConfirmRequestSchema,
) {}
