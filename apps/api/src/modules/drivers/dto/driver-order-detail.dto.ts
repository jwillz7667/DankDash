/**
 * Driver-scoped order detail — `GET /v1/driver/orders/:id`.
 *
 * The driver app needs a different projection than the consumer:
 *
 *   - The consumer hides `delivery_address_id` resolution behind a
 *     server-side join (one user can have many saved addresses, the
 *     consumer never sees the others).
 *   - The driver needs the dropoff address INLINE — they're navigating
 *     to it — and the ID-scan handoff state on the row.
 *   - The driver never sees the consumer's payment-method ref, but DOES
 *     see the order short code (read aloud as a fallback handoff
 *     verification) and the customer's masked phone (tap-to-call routes
 *     through Twilio Proxy in Phase 23).
 *
 * Cross-driver reads return 404 — same probe-resistance shape as the
 * consumer surface (`OrdersService.getForUser`). A driver who pastes
 * another driver's order id gets a 404, not a 403, so they can't
 * enumerate the assignment graph by status code.
 */
import { z } from 'zod';
import { OrderResponseSchema } from '../../checkout/dto/index.js';
import { OrderEventResponseSchema } from '../../orders/dto/index.js';

/**
 * Address snapshot as seen by the driver. The fields are the frozen
 * shape from `orders.delivery_address_snapshot` — captured at checkout
 * so a later edit on `user_addresses` cannot retroactively change the
 * driver's drop. Apartment / suite / floor information rides on
 * `line2`; the schema does not split it further.
 */
export const DriverDropoffAddressSchema = z
  .object({
    line1: z.string().min(1),
    line2: z.string().nullable(),
    city: z.string().min(1),
    state: z.string().length(2),
    postalCode: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
    instructions: z.string().nullable(),
  })
  .strict();

export type DriverDropoffAddress = z.infer<typeof DriverDropoffAddressSchema>;

/**
 * Customer-facing fields the driver needs at handoff. Names are split
 * so the UI renders "Sam J." rather than the consumer's full last name.
 */
export const DriverCustomerSummarySchema = z
  .object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    maskedPhone: z.string().nullable(),
  })
  .strict();

export type DriverCustomerSummary = z.infer<typeof DriverCustomerSummarySchema>;

/**
 * The dispensary pickup view from the driver's side. Latitude/longitude
 * come off the `dispensaries.location` PostGIS column projected through
 * the repo. The display name is the customer-facing one.
 */
export const DriverDispensarySummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().nullable(),
    city: z.string().min(1),
    state: z.string().length(2),
    postalCode: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
    phone: z.string().nullable(),
  })
  .strict();

export type DriverDispensarySummary = z.infer<typeof DriverDispensarySummarySchema>;

/**
 * Snapshot of the handoff state. `passed` becomes true once a Veriff
 * session for this order returns `approved`. `verificationId` is the
 * Veriff handle the iOS client passes to the SDK on re-scan or to the
 * result-poll endpoint. `scannedAt` is the timestamp written when the
 * gate flipped.
 */
export const DriverIdScanStateSchema = z
  .object({
    passed: z.boolean(),
    verificationId: z.string().nullable(),
    scannedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type DriverIdScanState = z.infer<typeof DriverIdScanStateSchema>;

export const DriverOrderDetailResponseSchema = z
  .object({
    order: OrderResponseSchema,
    events: z.array(OrderEventResponseSchema).readonly(),
    customer: DriverCustomerSummarySchema,
    dispensary: DriverDispensarySummarySchema,
    dropoff: DriverDropoffAddressSchema,
    idScan: DriverIdScanStateSchema,
  })
  .strict();

export type DriverOrderDetailResponse = z.infer<typeof DriverOrderDetailResponseSchema>;
