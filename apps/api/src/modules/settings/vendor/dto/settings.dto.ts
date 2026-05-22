/**
 * Vendor-settings DTOs.
 *
 *   GET   /v1/vendor/settings  → full settings response (hours, branding,
 *                                address, license, integrations summary)
 *   PATCH /v1/vendor/settings  → partial update (hours, branding, contact,
 *                                isAcceptingOrders)
 *
 * The vendor settings page surfaces fields the operator can edit (hours,
 * branding, accepting-orders) and read-only fields the platform owns
 * (license metadata, geo polygon, payment account ref, POS / Metrc
 * config). The read-only fields render with explicit "contact support
 * to change" messaging — the only escape hatch is the platform admin
 * console.
 *
 * Encrypted columns (`metrcApiKeyEnc`, `posCredentialsEnc`) are never
 * surfaced through this endpoint. The settings page renders only:
 *   - whether a value is configured (`hasMetrcCredentials`, etc.)
 *   - the public sibling (`metrcFacilityId`, `posProvider`)
 * That way a stray middleware log or browser extension can't capture
 * the secret in transit.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  DispensaryHoursSchema,
  GeoPointSchema,
  GeoPolygonSchema,
  LicenseTypeSchema,
} from '../../../dispensaries/dto/dispensary.dto.js';

/** `#RRGGBB` (case-insensitive, no shorthand). */
const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, 'must be #RRGGBB');

const PhoneNumber = z
  .string()
  .min(7, 'phone too short')
  .max(32, 'phone too long')
  // Permissive — the catalog already stores plain digits + punctuation. We're
  // not the source of truth for phone-number validation.
  .regex(/^[+()\-\s\d.]+$/u, 'phone contains illegal characters');

const Email = z.string().email().max(320);

const PosProviderSchema = z.enum(['dutchie', 'flowhub', 'treez', 'greenbits', 'cova', 'manual']);
export type PosProvider = z.infer<typeof PosProviderSchema>;

/**
 * Full GET response. The shape carries everything the settings page needs
 * to render every section in one round trip — there's no second call for
 * "store info" vs. "integrations" because the operator scrolls through
 * the whole page.
 */
export const VendorSettingsResponseSchema = z
  .object({
    id: z.string().uuid(),
    legalName: z.string(),
    dba: z.string().nullable(),

    licenseNumber: z.string(),
    licenseType: LicenseTypeSchema,
    licenseIssuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    licenseExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),

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
    brandColorHex: HexColor.nullable(),

    isAcceptingOrders: z.boolean(),
    status: z.enum(['onboarding', 'active', 'paused', 'terminated']),

    // Integrations — public siblings only.
    posProvider: PosProviderSchema,
    posLastSyncedAt: z.string().datetime({ offset: true }).nullable(),
    hasPosCredentials: z.boolean(),

    metrcFacilityId: z.string().nullable(),
    hasMetrcCredentials: z.boolean(),

    // Payments.
    hasAeropayAccount: z.boolean(),

    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type VendorSettingsResponse = z.infer<typeof VendorSettingsResponseSchema>;

/**
 * Patch payload. Every field is optional — the portal sends only the
 * sections the operator actually touched. An empty body is rejected so
 * a stray PATCH with no fields doesn't bump `updatedAt` for nothing.
 */
export const PatchVendorSettingsSchema = z
  .object({
    hours: DispensaryHoursSchema.optional(),
    phone: PhoneNumber.nullable().optional(),
    email: Email.nullable().optional(),
    logoImageKey: z.string().min(1).max(512).nullable().optional(),
    heroImageKey: z.string().min(1).max(512).nullable().optional(),
    brandColorHex: HexColor.nullable().optional(),
    isAcceptingOrders: z.boolean().optional(),
  })
  .strict()
  .refine((val) => Object.values(val).some((v) => v !== undefined), {
    message: 'PATCH must include at least one field',
  });

export type PatchVendorSettingsRequest = z.infer<typeof PatchVendorSettingsSchema>;

export class PatchVendorSettingsDto extends createZodDto(PatchVendorSettingsSchema) {}
