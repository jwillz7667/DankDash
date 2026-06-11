/**
 * Wire-format schemas for the orders surface. Zod is the single source of
 * truth: each schema validates inbound bodies and is exported alongside
 * the inferred type so controllers can stay in one shape and the
 * OpenAPI generator (Phase 18) can pick them up via `nestjs-zod`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { decodeOrderCursor } from '../order-cursor.js';

export const RejectOrderRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type RejectOrderRequest = z.infer<typeof RejectOrderRequestSchema>;
export class RejectOrderRequestDto extends createZodDto(RejectOrderRequestSchema) {}

export const CancelOrderRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;
export class CancelOrderRequestDto extends createZodDto(CancelOrderRequestSchema) {}

const RatingScore = z.number().int().min(1).max(5);

export const RateOrderRequestSchema = z
  .object({
    rating: RatingScore.optional(),
    review: z.string().trim().min(1).max(2000).optional(),
    driverRating: RatingScore.optional(),
    dispensaryRating: RatingScore.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.rating !== undefined ||
      v.review !== undefined ||
      v.driverRating !== undefined ||
      v.dispensaryRating !== undefined,
    { message: 'at least one of rating, review, driverRating, dispensaryRating is required' },
  );
export type RateOrderRequest = z.infer<typeof RateOrderRequestSchema>;
export class RateOrderRequestDto extends createZodDto(RateOrderRequestSchema) {}

/**
 * `GET /v1/orders` query. `status` partitions the user's history into the
 * Active and Past tabs (`'all'` is the admin/back-compat default — a
 * paramless call still returns everything). `cursor` is the opaque keyset
 * token from a previous page; it's decoded here at the boundary so a
 * malformed token surfaces as a 422 VALIDATION_FAILED rather than a
 * silently-wrong page. The decoded `{ placedAt, id }` is what the service
 * hands to the repo's cursored scan.
 */
export const ListOrdersQuerySchema = z
  .object({
    status: z.enum(['active', 'completed', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .min(1)
      .transform((raw, ctx) => {
        const decoded = decodeOrderCursor(raw);
        if (decoded === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid cursor' });
          return z.NEVER;
        }
        return decoded;
      })
      .optional(),
  })
  .strict();
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;
export class ListOrdersQueryDto extends createZodDto(ListOrdersQuerySchema) {}

const OrderStatusSchema = z.enum([
  'placed',
  'payment_failed',
  'accepted',
  'rejected',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'dispatch_failed',
  'driver_assigned',
  'en_route_pickup',
  'picked_up',
  'en_route_dropoff',
  'arrived_at_dropoff',
  'id_scan_pending',
  'id_scan_passed',
  'id_scan_failed',
  'delivered',
  'returned_to_store',
  'canceled',
  'disputed',
]);

/**
 * Vendor queue defaults: the four columns the portal renders by
 * default. `ready_for_pickup`, `awaiting_driver`, `driver_assigned`
 * collapse into the "ready" column visually but stay separate in the
 * data so the portal can badge dispatch-state without a second
 * roundtrip. `en_route_pickup` stays in the set because that is the
 * status where the driver is at the counter and the vendor confirms
 * handoff — dropping it would hide the order at the exact moment the
 * dispensary has to act.
 */
export const VENDOR_QUEUE_DEFAULT_STATUSES = [
  'placed',
  'accepted',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'driver_assigned',
  'en_route_pickup',
] as const satisfies readonly z.infer<typeof OrderStatusSchema>[];

/**
 * Comma-separated `statuses` filter, e.g. `?statuses=placed,accepted`.
 * Defaults to {@link VENDOR_QUEUE_DEFAULT_STATUSES} when omitted so the
 * portal's first paint hits a single fast endpoint.
 * `limit` caps at 200 — the queue surface tolerates more rows than the
 * customer list because a busy dispensary can have 100+ live orders.
 */
export const ListVendorOrdersQuerySchema = z
  .object({
    statuses: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw.trim() === '') {
          return [...VENDOR_QUEUE_DEFAULT_STATUSES];
        }
        const parts = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (parts.length === 0) return [...VENDOR_QUEUE_DEFAULT_STATUSES];
        const out: z.infer<typeof OrderStatusSchema>[] = [];
        for (const part of parts) {
          const parsed = OrderStatusSchema.safeParse(part);
          if (!parsed.success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `unknown status: ${part}`,
              path: ['statuses'],
            });
            return z.NEVER;
          }
          out.push(parsed.data);
        }
        return out;
      }),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .strict();
export type ListVendorOrdersQuery = z.infer<typeof ListVendorOrdersQuerySchema>;
export class ListVendorOrdersQueryDto extends createZodDto(ListVendorOrdersQuerySchema) {}

const OrderTimestampsSchema = z
  .object({
    placedAt: z.string(),
    paymentFailedAt: z.string().nullable(),
    acceptedAt: z.string().nullable(),
    rejectedAt: z.string().nullable(),
    preppingAt: z.string().nullable(),
    preparedAt: z.string().nullable(),
    awaitingDriverAt: z.string().nullable(),
    dispatchFailedAt: z.string().nullable(),
    driverAssignedAt: z.string().nullable(),
    enRoutePickupAt: z.string().nullable(),
    pickedUpAt: z.string().nullable(),
    enRouteDropoffAt: z.string().nullable(),
    arrivedAtDropoffAt: z.string().nullable(),
    idScanPendingAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    returnedToStoreAt: z.string().nullable(),
    canceledAt: z.string().nullable(),
    disputedAt: z.string().nullable(),
    ratedAt: z.string().nullable(),
  })
  .strict();

export const OrderResponseSchema = z
  .object({
    id: z.string().uuid(),
    shortCode: z.string(),
    userId: z.string().uuid(),
    dispensaryId: z.string().uuid(),
    driverId: z.string().uuid().nullable(),
    status: OrderStatusSchema,
    statusChangedAt: z.string(),
    subtotalCents: z.number().int(),
    cannabisTaxCents: z.number().int(),
    salesTaxCents: z.number().int(),
    deliveryFeeCents: z.number().int(),
    driverTipCents: z.number().int(),
    discountCents: z.number().int(),
    totalCents: z.number().int(),
    timestamps: OrderTimestampsSchema,
    ratings: z
      .object({
        customer: z.number().int().min(1).max(5).nullable(),
        review: z.string().nullable(),
        dispensary: z.number().int().min(1).max(5).nullable(),
        driver: z.number().int().min(1).max(5).nullable(),
      })
      .strict(),
  })
  .strict();
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

/**
 * Slim list-row projection for `GET /v1/orders` — the Orders tab needs the
 * code, dispensary, status, total, and the two timestamps it sorts/labels
 * by; it loads items + events + compliance snapshot on demand from the
 * detail endpoint. Mirrors the iOS `OrderListItemDTO`.
 */
export const OrderListItemSchema = z
  .object({
    id: z.string().uuid(),
    shortCode: z.string(),
    dispensaryId: z.string().uuid(),
    status: OrderStatusSchema,
    totalCents: z.number().int(),
    placedAt: z.string(),
    statusChangedAt: z.string(),
  })
  .strict();
export type OrderListItem = z.infer<typeof OrderListItemSchema>;

/**
 * Cursor-paginated list envelope. `nextCursor: null` marks the last page so
 * the client knows to stop. Mirrors the iOS `OrderListResponseDTO`.
 */
export const ListOrdersResponseSchema = z
  .object({
    items: z.array(OrderListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ListOrdersResponse = z.infer<typeof ListOrdersResponseSchema>;

export const TransitionResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: OrderStatusSchema,
    statusChangedAt: z.string(),
  })
  .strict();
export type TransitionResponse = z.infer<typeof TransitionResponseSchema>;

/**
 * Append-only `order_events` row projected for HTTP surfaces (driver
 * order detail, future vendor / consumer timeline views). `eventType`
 * is left as a free-form string here rather than narrowed to
 * `OrderEventType` — historical rows written before a renaming would
 * fail strict enum parsing, and the timeline UI renders them verbatim.
 * `actorUserId` and `actorRole` are nullable because system-fired
 * events (DISPATCH_QUEUE, ID_SCAN_PASSED via webhook) have no human
 * actor on the row.
 */
export const OrderEventResponseSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    eventType: z.string(),
    actorUserId: z.string().uuid().nullable(),
    actorRole: z.string().nullable(),
    payload: z.record(z.unknown()),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type OrderEventResponse = z.infer<typeof OrderEventResponseSchema>;

/**
 * Lean queue-card projection for the vendor portal. Carries only what
 * a kanban card needs (status, who, totals, timestamps); the drawer
 * fetches the full {@link OrderResponse} via `GET /:id` when the staff
 * member taps in. `customerName` may be null when the user has been
 * soft-deleted but their order still lives — the card renders the
 * short code as a fallback.
 */
export const VendorQueueOrderResponseSchema = z
  .object({
    id: z.string().uuid(),
    shortCode: z.string(),
    userId: z.string().uuid(),
    customerName: z.string().nullable(),
    status: OrderStatusSchema,
    itemCount: z.number().int().nonnegative(),
    subtotalCents: z.number().int(),
    totalCents: z.number().int(),
    placedAt: z.string(),
    statusChangedAt: z.string(),
    acceptedAt: z.string().nullable(),
    preppingAt: z.string().nullable(),
    preparedAt: z.string().nullable(),
  })
  .strict();
export type VendorQueueOrderResponse = z.infer<typeof VendorQueueOrderResponseSchema>;

export const ListVendorQueueResponseSchema = z
  .object({ orders: z.array(VendorQueueOrderResponseSchema) })
  .strict();
export type ListVendorQueueResponse = z.infer<typeof ListVendorQueueResponseSchema>;
