/**
 * Wire-format schemas for the orders surface. Zod is the single source of
 * truth: each schema validates inbound bodies and is exported alongside
 * the inferred type so controllers can stay in one shape and the
 * OpenAPI generator (Phase 18) can pick them up via `nestjs-zod`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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

export const ListOrdersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
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

export const ListOrdersResponseSchema = z.object({ orders: z.array(OrderResponseSchema) }).strict();
export type ListOrdersResponse = z.infer<typeof ListOrdersResponseSchema>;

export const TransitionResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: OrderStatusSchema,
    statusChangedAt: z.string(),
  })
  .strict();
export type TransitionResponse = z.infer<typeof TransitionResponseSchema>;
