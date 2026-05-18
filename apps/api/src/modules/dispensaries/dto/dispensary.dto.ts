/**
 * Dispensary detail + list DTOs.
 *
 *   GET /v1/dispensaries           — flat list, optionally filtered to those
 *                                    serving a (lat,lng) point via PostGIS
 *                                    ST_Contains on `delivery_polygon`.
 *   GET /v1/dispensaries/:id       — single dispensary detail.
 *
 * Both surfaces include the live `isOpenNow` flag and a forward-looking
 * `opensAt` ISO instant. The MN statutory sale-hours cap is intersected
 * with the dispensary's declared schedule, so a store with `09:00–02:00`
 * hours is open from `09:00–02:00` on a normal day but only from `10:00–02:00`
 * on the spring-forward day (the rule is enforced by @dankdash/dispensaries,
 * not duplicated here).
 *
 * Internal columns the response deliberately omits:
 *
 *   - `metrcApiKeyEnc`, `posCredentialsEnc` — encrypted POS/Metrc creds.
 *   - `posProvider`, `posLastSyncedAt`      — vendor-internal observability.
 *   - `aeropayAccountRef`                   — payment-processor account ref.
 *   - `licenseIssuedAt`, `licenseExpiresAt` — internal audit; the license
 *                                             number alone is the public
 *                                             trust signal.
 *   - `deletedAt`                           — tombstone, never surfaced.
 *
 * Geo fields use the same GeoJSON shape the repository inflates from
 * `ST_AsGeoJSON`. The iOS client overlays `deliveryPolygon` on its MapKit
 * delivery-zone view; surfacing it on the list lets the map render in a
 * single round trip without hitting the detail endpoint per pin.
 */
import { z } from 'zod';

/** GeoJSON longitude/latitude pair, WGS84. */
const Coordinate = z.tuple([z.number(), z.number()]).readonly();

export const GeoPointSchema = z
  .object({
    type: z.literal('Point'),
    coordinates: Coordinate,
  })
  .strict();
export type GeoPointDto = z.infer<typeof GeoPointSchema>;

export const GeoPolygonSchema = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(Coordinate).readonly()).readonly(),
  })
  .strict();
export type GeoPolygonDto = z.infer<typeof GeoPolygonSchema>;

/**
 * `HH:MM` 24-hour. Hours up to `30` are valid to allow next-day close
 * encoding (a store closing at 02:00 the following day may be written as
 * `26:00`). Matches the parser in @dankdash/dispensaries.
 */
const HHMM = z.string().regex(/^([0-2]?\d|30):[0-5]\d$/u, 'must be HH:MM in 24-hour');

export const DayHoursSchema = z
  .object({
    open: HHMM,
    close: HHMM,
  })
  .strict();
export type DayHoursDto = z.infer<typeof DayHoursSchema>;

export const DispensaryHoursSchema = z
  .object({
    mon: DayHoursSchema.nullable(),
    tue: DayHoursSchema.nullable(),
    wed: DayHoursSchema.nullable(),
    thu: DayHoursSchema.nullable(),
    fri: DayHoursSchema.nullable(),
    sat: DayHoursSchema.nullable(),
    sun: DayHoursSchema.nullable(),
  })
  .strict();
export type DispensaryHoursDto = z.infer<typeof DispensaryHoursSchema>;

export const LicenseTypeSchema = z.enum([
  'retailer',
  'microbusiness',
  'mezzobusiness',
  'medical_combo',
  'delivery_service',
  'lphe_retailer',
]);
export type LicenseTypeDto = z.infer<typeof LicenseTypeSchema>;

/**
 * `terminated` and `paused` dispensaries surface as 404 from the public
 * read endpoints; `onboarding` are pre-launch and also hidden. The enum is
 * here only so the schema can document the shape — the public projection
 * always emits `'active'`.
 */
export const DispensaryStatusSchema = z.enum(['onboarding', 'active', 'paused', 'terminated']);
export type DispensaryStatusDto = z.infer<typeof DispensaryStatusSchema>;

const RATING_STRING = z.string().regex(/^\d+(\.\d{1,2})?$/u, 'must be a 0..5 rating string');

export const DispensaryResponseSchema = z
  .object({
    id: z.string().uuid(),
    legalName: z.string(),
    dba: z.string().nullable(),
    licenseNumber: z.string(),
    licenseType: LicenseTypeSchema,
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    city: z.string(),
    region: z.string(),
    postalCode: z.string(),
    location: GeoPointSchema,
    deliveryPolygon: GeoPolygonSchema,
    hours: DispensaryHoursSchema,
    phone: z.string().nullable(),
    email: z.string().nullable(),
    logoImageKey: z.string().nullable(),
    heroImageKey: z.string().nullable(),
    brandColorHex: z.string().nullable(),
    isAcceptingOrders: z.boolean(),
    isOpenNow: z.boolean(),
    /** `null` when currently open OR no upcoming open window within 14 days. */
    opensAt: z.string().datetime({ offset: true }).nullable(),
    ratingAvg: RATING_STRING.nullable(),
    ratingCount: z.number().int().nonnegative(),
    status: DispensaryStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DispensaryResponse = z.infer<typeof DispensaryResponseSchema>;

export const DispensaryListResponseSchema = z
  .object({
    dispensaries: z.array(DispensaryResponseSchema).readonly(),
  })
  .strict();

export type DispensaryListResponse = z.infer<typeof DispensaryListResponseSchema>;
