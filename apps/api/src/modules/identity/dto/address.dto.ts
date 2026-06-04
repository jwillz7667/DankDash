/**
 * /v1/addresses DTOs.
 *
 *   GET   /v1/addresses        — returns the caller's non-deleted addresses,
 *                                default first then newest.
 *   POST  /v1/addresses        — creates a new address, optionally promoting
 *                                it to default in the same call.
 *   PATCH /v1/addresses/:id    — partial update; mutable surface excludes
 *                                `userId`, the timestamps, and the validation
 *                                flag pair (those are system-owned). The
 *                                `isDefault` toggle is opt-in and goes through
 *                                the atomic singleton-flip path in the repo.
 *
 * The wire shape for coordinates is `{ latitude, longitude }` rather than the
 * GeoJSON `{ type: 'Point', coordinates: [lng, lat] }` used elsewhere — the
 * iOS client composes coordinates from a CLLocationCoordinate2D returned by
 * MapKit's on-device geocoder, so accepting them flat avoids a per-call
 * translation step and a class of lng/lat order mistakes. The service
 * translates inward to a GeoPoint before handing it to the repo.
 *
 * Latitude is bounded `[-90, 90]`, longitude `[-180, 180]` — Zod enforces
 * the WGS84 envelope before anything reaches PostGIS.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const LatitudeSchema = z.number().gte(-90).lte(90);
const LongitudeSchema = z.number().gte(-180).lte(180);

/**
 * Response shape. `location` is rendered as a flat `{ latitude, longitude }`
 * pair for the same reason the request accepts that shape — clients only
 * ever consume the two scalars (map pin placement, distance hint).
 */
export const UserAddressResponseSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    region: z.string(),
    postalCode: z.string(),
    country: z.string(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
      })
      .strict(),
    isDefault: z.boolean(),
    isValidated: z.boolean(),
    validatedAt: z.string().datetime({ offset: true }).nullable(),
    deliveryInstructions: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type UserAddressResponse = z.infer<typeof UserAddressResponseSchema>;

export const ListAddressesResponseSchema = z
  .object({
    addresses: z.array(UserAddressResponseSchema).readonly(),
  })
  .strict();
export type ListAddressesResponse = z.infer<typeof ListAddressesResponseSchema>;

/**
 * Length caps mirror Postgres `text` semantics — Postgres itself is
 * unbounded, but capping at the DTO keeps a 5 MB POST from a buggy client
 * out of the DB. The 80/200 picks line up with US postal-line standards.
 */
export const CreateAddressRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(2).max(80),
    postalCode: z.string().trim().min(3).max(20),
    country: z.string().trim().length(2).default('US'),
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    deliveryInstructions: z.string().trim().max(500).optional(),
    /**
     * When true the new row is promoted to default in the same transaction
     * (clears whatever row currently holds the singleton). Defaults to
     * false; iOS sends `true` only when the user explicitly picked
     * "save as default" or this is the user's first address.
     */
    setAsDefault: z.boolean().optional(),
  })
  .strict();
export class CreateAddressRequestDto extends createZodDto(CreateAddressRequestSchema) {}

/**
 * Partial update. Excludes the validation flags + timestamps (system-owned)
 * and `userId` (not user-mutable). `isDefault: true` flips the singleton;
 * `isDefault: false` is rejected because the only way to drop the default
 * is to promote a different row — leaving the user with no default address
 * breaks the cart-validate preflight invariant.
 */
export const PatchAddressRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80).nullable(),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().min(1).max(200).nullable(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(2).max(80),
    postalCode: z.string().trim().min(3).max(20),
    country: z.string().trim().length(2),
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    deliveryInstructions: z.string().trim().max(500).nullable(),
    isDefault: z.literal(true),
  })
  .strict()
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field must be provided',
  })
  .refine((obj) => (obj.latitude === undefined) === (obj.longitude === undefined), {
    message: 'latitude and longitude must be provided together',
  });
export class PatchAddressRequestDto extends createZodDto(PatchAddressRequestSchema) {}
