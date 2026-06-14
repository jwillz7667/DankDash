/**
 * Canonical event payloads carried by the `dankdash:realtime` Redis Stream.
 *
 * The stream is a single source of truth for *all* cross-service broadcasts:
 * the API and workers publish here; the realtime service is the only
 * consumer. Keeping every shape in one place means a) the producer side
 * cannot drift away from the consumer side (a missing field is a typecheck
 * error in both halves) and b) replay/debugging tools can decode any
 * historical entry without per-event guesswork.
 *
 * Each event carries a discriminant `type` and a `payload` whose shape is
 * tied to that discriminant. Zod schemas back the runtime validation on
 * the consumer side — a malformed stream entry is logged + skipped, not
 * silently dropped or crashed-on. The XADD on the producer side calls
 * `serializeStreamEvent` which both validates and base64-encodes the
 * payload, so a malformed event cannot leave the producer process.
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const positiveNumber = z.number().positive();

/**
 * Canonical statuses we broadcast. Kept loose-coupled from the DB enum so
 * a future status addition does not require coordinating a deploy between
 * the API and the realtime service — the realtime service forwards whatever
 * the producer sends.
 */
export const orderStatusSchema = z.string().min(1).max(64);

export const orderCreatedPayloadSchema = z.object({
  orderId: uuid,
  customerId: uuid,
  dispensaryId: uuid,
  shortCode: z.string().min(1).max(32),
  totalCents: z.number().int().nonnegative(),
  status: orderStatusSchema,
  placedAt: isoTimestamp,
});
export type OrderCreatedPayload = z.infer<typeof orderCreatedPayloadSchema>;

export const orderStatusChangedPayloadSchema = z.object({
  orderId: uuid,
  customerId: uuid,
  dispensaryId: uuid,
  driverId: uuid.nullable(),
  fromStatus: orderStatusSchema,
  toStatus: orderStatusSchema,
  changedAt: isoTimestamp,
});
export type OrderStatusChangedPayload = z.infer<typeof orderStatusChangedPayloadSchema>;

export const driverLocationPayloadSchema = z.object({
  driverId: uuid,
  orderId: uuid.nullable(),
  customerId: uuid.nullable(),
  // The dispensary fulfilling the active order, so the router can fan the
  // location to the vendor's per-order tracking map as well as the
  // customer. Null when the driver isn't on a delivery (same gate as
  // orderId/customerId).
  dispensaryId: uuid.nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: positiveNumber.nullable(),
  speedMps: z.number().nullable(),
  headingDeg: z.number().min(0).max(360).nullable(),
  recordedAt: isoTimestamp,
});
export type DriverLocationPayload = z.infer<typeof driverLocationPayloadSchema>;

export const offerNewPayloadSchema = z.object({
  offerId: uuid,
  orderId: uuid,
  driverId: uuid,
  expiresAt: isoTimestamp,
  payoutEstimateCents: z.number().int().nonnegative(),
  distanceMiles: z.number().nonnegative(),
});
export type OfferNewPayload = z.infer<typeof offerNewPayloadSchema>;

export const offerExpiredPayloadSchema = z.object({
  offerId: uuid,
  orderId: uuid,
  driverId: uuid,
  expiredAt: isoTimestamp,
});
export type OfferExpiredPayload = z.infer<typeof offerExpiredPayloadSchema>;

/**
 * Phase 10.3 — customer-facing ETA refresh. The workers' eta observer
 * publishes one of these alongside every committed `driver:location`
 * envelope for an order that is en route to the dropoff. The realtime
 * service fans it to the customer room only (vendor + driver already
 * see the location event; the ETA is a customer-experience refinement).
 *
 * `source` mirrors `EtaResult.source` so the iOS app can render
 * "approx ETA" differently when it came from the haversine fallback —
 * useful for muting overconfident ETAs during a Mapbox outage.
 */
export const customerEtaUpdatedPayloadSchema = z.object({
  orderId: uuid,
  customerId: uuid,
  driverId: uuid,
  etaSeconds: positiveNumber,
  distanceMeters: z.number().nonnegative(),
  source: z.enum(['cache', 'mapbox', 'fallback']),
  computedAt: isoTimestamp,
});
export type CustomerEtaUpdatedPayload = z.infer<typeof customerEtaUpdatedPayloadSchema>;

export const REALTIME_EVENT_TYPES = [
  'order:created',
  'order:status_changed',
  'driver:location',
  'offer:new',
  'offer:expired',
  'customer:eta_updated',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * Tagged union — one entry per event type. The consumer narrows on `type`
 * to recover the strongly-typed payload. zod's discriminatedUnion gives
 * us cheap O(1) dispatch on the wire too.
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('order:created'), payload: orderCreatedPayloadSchema }),
  z.object({ type: z.literal('order:status_changed'), payload: orderStatusChangedPayloadSchema }),
  z.object({ type: z.literal('driver:location'), payload: driverLocationPayloadSchema }),
  z.object({ type: z.literal('offer:new'), payload: offerNewPayloadSchema }),
  z.object({ type: z.literal('offer:expired'), payload: offerExpiredPayloadSchema }),
  z.object({
    type: z.literal('customer:eta_updated'),
    payload: customerEtaUpdatedPayloadSchema,
  }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/**
 * Envelope that wraps every event on the wire. `id` is the producer-side
 * UUID (idempotency key for at-least-once delivery — the consumer
 * deduplicates by id within a sliding window), `emittedAt` is the
 * producer's wall clock, `source` is the service that emitted (api,
 * workers — debugging crutch when an event looks wrong).
 *
 * The Redis stream entry's auto-generated `<ms>-<seq>` ID is separate and
 * used by the consumer for offset tracking; `id` here is application-level
 * and survives a stream trim/replay.
 */
export const realtimeEnvelopeSchema = z.object({
  id: uuid,
  emittedAt: isoTimestamp,
  source: z.enum(['api', 'workers']),
  event: realtimeEventSchema,
});
export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;
