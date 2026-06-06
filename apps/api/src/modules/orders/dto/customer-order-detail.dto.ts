/**
 * Customer-scoped order detail — `GET /v1/orders/:id`.
 *
 * The consumer tracking screen needs a different projection than both
 * the vendor kanban and the driver app:
 *
 *   - The flat checkout order shape (same `OrderResponseSchema` the
 *     consumer already received from `POST /v1/checkout`), NOT the
 *     nested vendor `OrderResponseSchema` in `./index.ts`. Reusing the
 *     checkout schema keeps the iOS `OrderResponseDTO` decode identical
 *     across checkout and tracking.
 *   - Two map points: where the order is coming FROM (the dispensary)
 *     and going TO (the customer's own drop-off). The consumer only
 *     needs the display name + coordinate for each, not the full street
 *     address the driver detail carries.
 *   - A privacy-minimal driver card, present only once a driver is
 *     assigned: display name ("Sam J."), masked phone, a vehicle
 *     summary string — never the raw last name or E.164.
 *
 * Cross-customer reads 404 (probe-resistant), same as the rest of the
 * orders surface (`OrdersService.findForUser`).
 */
import { z } from 'zod';
import { OrderResponseSchema } from '../../checkout/dto/index.js';
import { OrderEventResponseSchema } from './index.js';

/**
 * Privacy-minimal driver card the consumer sees once a driver is
 * assigned. `displayName` is the first name + last initial ("Sam J.");
 * `maskedPhone` is last-4 only; `avatarKey` is reserved for a future
 * driver-photo column and is always `null` today (the iOS field is
 * optional and the card degrades gracefully). `vehicleSummary` is a
 * human string like "Silver 2021 Toyota Prius" composed from the
 * driver row's vehicle fields, or `null` when none are recorded.
 */
export const DriverPublicProfileSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    avatarKey: z.string().nullable(),
    vehicleSummary: z.string().nullable(),
    maskedPhone: z.string().nullable(),
  })
  .strict();

export type DriverPublicProfile = z.infer<typeof DriverPublicProfileSchema>;

/**
 * Pickup pin — the dispensary the order is coming from. Coordinates are
 * read off the `dispensaries.location` PostGIS column projected through
 * the repo. The consumer needs only the display name + point; the full
 * street address lives on the driver-side detail.
 */
export const CustomerOrderDispensarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
  })
  .strict();

export type CustomerOrderDispensary = z.infer<typeof CustomerOrderDispensarySchema>;

/**
 * Drop-off pin — the customer's OWN delivery address, read from the
 * `orders.delivery_address_snapshot` JSONB frozen at checkout (so a
 * later edit to the saved address can't move the pin). `line1` doubles
 * as the map label on the consumer side.
 */
export const CustomerOrderDropoffSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    line1: z.string().min(1),
    line2: z.string().nullable(),
    city: z.string().min(1),
    state: z.string().length(2),
    postalCode: z.string().min(1),
    instructions: z.string().nullable(),
  })
  .strict();

export type CustomerOrderDropoff = z.infer<typeof CustomerOrderDropoffSchema>;

export const CustomerOrderDetailResponseSchema = z
  .object({
    order: OrderResponseSchema,
    events: z.array(OrderEventResponseSchema).readonly(),
    driver: DriverPublicProfileSchema.nullable(),
    dispensary: CustomerOrderDispensarySchema,
    dropoff: CustomerOrderDropoffSchema,
  })
  .strict();

export type CustomerOrderDetailResponse = z.infer<typeof CustomerOrderDetailResponseSchema>;
