/**
 * Admin DTOs for dispensary write paths.
 *
 *   POST  /v1/admin/dispensaries        — CreateDispensaryRequest
 *   PATCH /v1/admin/dispensaries/:id    — PatchDispensaryRequest
 *
 * Create accepts every field the schema requires plus optional brand /
 * presentation fields. Status is intentionally **not** accepted: new rows
 * always start at `onboarding` and transition through the activate/suspend
 * endpoints so the audit trail records the operator who moved them.
 *
 * Patch is the same shape minus the identity-only fields (license number,
 * legal name, region) that should never be silently updated — those move
 * via a license-correction admin tool that does not exist yet. All
 * remaining fields are optional; the service rejects an empty patch so a
 * no-op PATCH cannot generate a meaningless updated_at bump.
 *
 * Hours payload is reused from the public read DTO; the schema doesn't
 * differ between the customer-facing projection and the admin write path.
 * GeoPoint/GeoPolygon likewise — GeoJSON in, GeoJSON out.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  DispensaryHoursSchema,
  GeoPointSchema,
  GeoPolygonSchema,
  LicenseTypeSchema,
} from '../../dto/dispensary.dto.js';

const PosProviderSchema = z.enum(['dutchie', 'flowhub', 'treez', 'greenbits', 'cova', 'manual']);

/**
 * `YYYY-MM-DD` calendar date. The schema column is `date`, so the wire
 * format is the same canonical ISO date — no time component, no timezone.
 */
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be YYYY-MM-DD');

/** RFC-7613 phone-number passthrough — actual carrier validation is out of scope here. */
const Phone = z
  .string()
  .min(7)
  .max(32)
  .regex(/^[+0-9 ()-]+$/u, 'must look like a phone number');

const Email = z.string().email().max(254);

/** A web-hex color like `#0E5E2A` or `#0e5e2a`. */
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'must be a 6-digit hex like #1A2B3C');

export const CreateDispensaryRequestSchema = z
  .object({
    legalName: z.string().min(1).max(200),
    dba: z.string().min(1).max(200).nullable().optional(),
    licenseNumber: z.string().min(1).max(64),
    licenseType: LicenseTypeSchema,
    licenseIssuedAt: ISODate,
    licenseExpiresAt: ISODate,
    metrcFacilityId: z.string().min(1).max(64).nullable().optional(),
    posProvider: PosProviderSchema.optional(),
    addressLine1: z.string().min(1).max(200),
    addressLine2: z.string().min(1).max(200).nullable().optional(),
    city: z.string().min(1).max(100),
    region: z.string().length(2, 'must be a 2-letter state code'),
    postalCode: z.string().min(5).max(10),
    location: GeoPointSchema,
    deliveryPolygon: GeoPolygonSchema,
    hours: DispensaryHoursSchema,
    phone: Phone.nullable().optional(),
    email: Email.nullable().optional(),
    logoImageKey: z.string().min(1).max(500).nullable().optional(),
    heroImageKey: z.string().min(1).max(500).nullable().optional(),
    brandColorHex: HexColor.nullable().optional(),
  })
  .strict()
  .refine((d) => d.licenseExpiresAt > d.licenseIssuedAt, {
    message: 'licenseExpiresAt must be strictly after licenseIssuedAt',
    path: ['licenseExpiresAt'],
  });

export type CreateDispensaryRequest = z.infer<typeof CreateDispensaryRequestSchema>;

export class CreateDispensaryRequestDto extends createZodDto(CreateDispensaryRequestSchema) {}

/**
 * Patch accepts a strict subset of create. Fields excluded:
 *
 *   - licenseNumber  — corrections go through a dedicated admin path that
 *                      writes an audit row; silent renames are unsafe.
 *   - region         — moving a dispensary to a different state crosses
 *                      compliance jurisdictions; not a casual patch.
 *
 * Empty objects are rejected by the service (not the schema) so the error
 * message can be specific and the schema can stay declarative.
 */
export const PatchDispensaryRequestSchema = z
  .object({
    legalName: z.string().min(1).max(200).optional(),
    dba: z.string().min(1).max(200).nullable().optional(),
    licenseType: LicenseTypeSchema.optional(),
    licenseIssuedAt: ISODate.optional(),
    licenseExpiresAt: ISODate.optional(),
    metrcFacilityId: z.string().min(1).max(64).nullable().optional(),
    posProvider: PosProviderSchema.optional(),
    addressLine1: z.string().min(1).max(200).optional(),
    addressLine2: z.string().min(1).max(200).nullable().optional(),
    city: z.string().min(1).max(100).optional(),
    postalCode: z.string().min(5).max(10).optional(),
    hours: DispensaryHoursSchema.optional(),
    phone: Phone.nullable().optional(),
    email: Email.nullable().optional(),
    logoImageKey: z.string().min(1).max(500).nullable().optional(),
    heroImageKey: z.string().min(1).max(500).nullable().optional(),
    brandColorHex: HexColor.nullable().optional(),
    isAcceptingOrders: z.boolean().optional(),
  })
  .strict()
  .refine(
    (patch) => {
      // When both dates are present in the same patch, enforce ordering;
      // the partial case (only one date in patch) defers ordering to a
      // service-level read so we don't pull the row twice.
      if (patch.licenseIssuedAt !== undefined && patch.licenseExpiresAt !== undefined) {
        return patch.licenseExpiresAt > patch.licenseIssuedAt;
      }
      return true;
    },
    {
      message: 'licenseExpiresAt must be strictly after licenseIssuedAt',
      path: ['licenseExpiresAt'],
    },
  );

export type PatchDispensaryRequest = z.infer<typeof PatchDispensaryRequestSchema>;

export class PatchDispensaryRequestDto extends createZodDto(PatchDispensaryRequestSchema) {}
