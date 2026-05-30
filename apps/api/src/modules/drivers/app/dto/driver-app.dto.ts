/**
 * DTOs for the driver-self app surface (Phase 8.5):
 *
 *   GET /v1/driver/current-route   — order in flight + pickup + dropoff
 *   GET /v1/driver/shifts          — recent shift history
 *
 * Earnings DTOs live in `../../dto/earnings.dto.ts` next to the
 * `DriverEarningsController` that serves `GET /v1/driver/earnings`.
 *
 * `CurrentRouteResponse.activeOrder` is `null` when the driver has no
 * order in flight. We deliberately do not 404 — the driver app polls this
 * endpoint on a tick to decide whether to render the "waiting for offers"
 * screen vs the "drive to pickup" screen, and the in-band null carries
 * more signal than a status code the network layer has to translate.
 *
 * `pickup` is the dispensary projected to a driver-relevant subset:
 * name, address, location (for MapKit), brand colour and phone (for the
 * "tap to call the store" affordance). `dropoff` reads from the order's
 * denormalised `delivery_address_snapshot` JSONB — so a customer editing
 * their saved address after checkout does not retroactively change where
 * the driver is supposed to deliver. `deliveryInstructions` ride on the
 * snapshot for the same reason.
 *
 * `ShiftsListResponse` is a flat array (no cursor) — `listForDriver`
 * caps at 50 rows; the driver app surfaces "recent shifts" and historic
 * detail goes through admin tooling, so cursor pagination is overkill
 * for this surface.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { GeoPointSchema } from '../../../dispensaries/dto/dispensary.dto.js';
import { OrderResponseSchema } from '../../../orders/dto/index.js';
import { DriverShiftResponseSchema } from '../../shift/dto/index.js';

/**
 * Pickup-side projection of the dispensary for the driver app. We surface
 * only fields the driver needs to drive to + interact with the store —
 * the public dispensary projection (which carries delivery polygon,
 * rating averages, isOpenNow, etc.) is overkill and leaks routing
 * details that have no place in a driver-facing view.
 */
export const PickupSchema = z
  .object({
    dispensaryId: z.string().uuid(),
    name: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    city: z.string(),
    region: z.string(),
    postalCode: z.string(),
    location: GeoPointSchema,
    phone: z.string().nullable(),
    brandColorHex: z.string().nullable(),
  })
  .strict();
export type Pickup = z.infer<typeof PickupSchema>;

/**
 * Dropoff projection mirrors the JSONB shape that
 * `apps/api/src/modules/checkout/checkout.service.ts:serializeAddress`
 * writes onto `orders.delivery_address_snapshot`. The schema validates
 * what we read out so a snapshot written by an older code path with a
 * different shape would surface as a 500 here (loud failure) instead of
 * silently rendering a partially-populated card in the driver app.
 *
 * `id` is the user_addresses row id at checkout time; we keep it so a
 * future "address book" view can correlate, but the driver UI never
 * needs to look it up. `location` may be null on legacy rows that
 * pre-date geocoding — handled at render time, not validated here.
 */
export const DropoffSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    region: z.string(),
    postalCode: z.string(),
    country: z.string(),
    location: GeoPointSchema.nullable(),
    deliveryInstructions: z.string().nullable(),
  })
  .strict();
export type Dropoff = z.infer<typeof DropoffSchema>;

export const CurrentRouteResponseSchema = z
  .object({
    activeOrder: z
      .object({
        order: OrderResponseSchema,
        pickup: PickupSchema,
        dropoff: DropoffSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CurrentRouteResponse = z.infer<typeof CurrentRouteResponseSchema>;
export class CurrentRouteResponseDto extends createZodDto(CurrentRouteResponseSchema) {}

export const ShiftsListResponseSchema = z
  .object({
    shifts: z.array(DriverShiftResponseSchema).readonly(),
  })
  .strict();
export type ShiftsListResponse = z.infer<typeof ShiftsListResponseSchema>;
export class ShiftsListResponseDto extends createZodDto(ShiftsListResponseSchema) {}
