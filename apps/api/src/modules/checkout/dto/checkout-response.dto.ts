/**
 * Checkout response — `POST /v1/carts/:id/checkout`.
 *
 * Surfaces three artefacts the iOS client needs right after a successful
 * checkout:
 *
 *   1. The newly-created `order` projection — every field the order-
 *      detail screen renders without a follow-up GET. The shape is the
 *      same one the future `/v1/orders/:id` endpoint will return, so the
 *      client's order-card component is shared across the two surfaces.
 *
 *   2. The `paymentIntent` envelope — provider name, opaque provider
 *      reference, status, and amount. Phase 5 stubs Aeropay so the
 *      `providerRef` is a synthetic id (`pi_stub_<order-short-code>`)
 *      and the `status` is always `initiated`. Phase 6's Aeropay
 *      integration replaces the stub with a real session id and may
 *      transition the status to `authorized` synchronously. The wire
 *      shape stays identical across the swap.
 *
 *   3. The `complianceCheck` snapshot — the full evaluator output that
 *      was just persisted onto `orders.compliance_check_payload`. The
 *      iOS client uses it to render the "we checked these rules"
 *      receipt strip and to keep its preview UI in sync with the server
 *      authoritative result. The shape is the same `ValidateCartResponse`
 *      the preview endpoint returns — clients can reuse their existing
 *      parser.
 *
 * Money is integer cents at this surface (it is at every monetary
 * surface in this codebase — see CLAUDE.md "Money, IDs, and time"). The
 * `orders_total_matches` CHECK constraint guarantees the totals in this
 * projection reconcile to the persisted row.
 */
import { z } from 'zod';
import { ValidateCartResponseSchema } from '../../cart/dto/index.js';

/**
 * Mirror of the `order_items` row shape needed by the order-detail
 * screen. `productSnapshot` is the per-line JSON the catalog captured at
 * checkout time — kept opaque here because the catalog snapshot's exact
 * shape evolves independently of order display (a future "lab results"
 * pill is added by extending the snapshot, not by changing this DTO).
 */
export const OrderItemResponseSchema = z
  .object({
    id: z.string().uuid(),
    listingId: z.string().uuid(),
    productSnapshot: z.record(z.unknown()),
    quantity: z.number().int().positive(),
    unitPriceCents: z.number().int().nonnegative(),
    lineSubtotalCents: z.number().int().nonnegative(),
    thcMgTotal: z.string(),
    cbdMgTotal: z.string(),
    weightGramsTotal: z.string(),
    cannabisTaxCents: z.number().int().nonnegative(),
    salesTaxCents: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OrderItemResponse = z.infer<typeof OrderItemResponseSchema>;

/**
 * `order_status` enum mirror. Kept in sync with `packages/db/src/schema/enums.ts`
 * — adding a state requires adding it here and in the iOS client. The
 * narrow Zod enum (vs `z.string()`) means a server-side bug that writes
 * an unknown status to the DB surfaces as a validation error on the
 * response, not a silently-broken client.
 */
export const OrderStatusSchema = z.enum([
  'placed',
  'payment_failed',
  'accepted',
  'rejected',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
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

export const OrderResponseSchema = z
  .object({
    id: z.string().uuid(),
    shortCode: z.string().length(6),
    userId: z.string().uuid(),
    dispensaryId: z.string().uuid(),
    deliveryAddressId: z.string().uuid(),
    status: OrderStatusSchema,
    subtotalCents: z.number().int().nonnegative(),
    cannabisTaxCents: z.number().int().nonnegative(),
    salesTaxCents: z.number().int().nonnegative(),
    deliveryFeeCents: z.number().int().nonnegative(),
    driverTipCents: z.number().int().nonnegative(),
    discountCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    items: z.array(OrderItemResponseSchema).readonly(),
    placedAt: z.string().datetime({ offset: true }),
    statusChangedAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

/**
 * Payment-intent envelope. The shape is provider-agnostic — `provider`
 * is the discriminator, `providerRef` is the opaque key the client hands
 * to the provider's SDK (Aeropay's session token) or to the next API
 * call (Aeropay webhook callbacks). The `clientSecret` slot is null for
 * Phase 5 (stubbed) and remains optional so Aeropay can populate it
 * with its hosted-iframe token in Phase 6 without a schema change.
 */
export const PaymentIntentResponseSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    provider: z.literal('aeropay'),
    providerRef: z.string().min(1),
    status: z.enum([
      'initiated',
      'authorized',
      'settled',
      'failed',
      'canceled',
      'refunded',
      'partially_refunded',
    ]),
    amountCents: z.number().int().nonnegative(),
    clientSecret: z.string().nullable(),
  })
  .strict();

export type PaymentIntentResponse = z.infer<typeof PaymentIntentResponseSchema>;

export const CheckoutResponseSchema = z
  .object({
    order: OrderResponseSchema,
    paymentIntent: PaymentIntentResponseSchema,
    complianceCheck: ValidateCartResponseSchema,
  })
  .strict();

export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
