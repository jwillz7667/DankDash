/**
 * Admin DTOs for the driver write paths.
 *
 *   POST  /v1/admin/drivers        — CreateDriverRequest
 *   PATCH /v1/admin/drivers/:id    — PatchDriverRequest
 *
 * Onboarding creates the `drivers` row AND promotes the linked user's
 * global role to `driver`. The license number arrives in plaintext on
 * the wire (over TLS, admin-authenticated only) and is hashed inside the
 * service — it is never stored or logged in clear. Hash output goes
 * straight into `drivers.license_number_hash` (bytea).
 *
 * Patch is a strict subset of create — `userId` and `licenseNumber` are
 * deliberately excluded:
 *   - userId: rebinding a driver row to a different user is dangerous;
 *     archive the row and onboard the user fresh instead.
 *   - licenseNumber: a license-number correction is a regulated event
 *     that needs an audit trail beyond `updated_at`; goes through a
 *     dedicated admin tool that does not exist yet.
 *
 * Vehicle, insurance, and background-check fields can all be patched.
 * Service-layer rules reject empty patches and an expired
 * insurance_expires_at; activation gates (background check passed,
 * insurance valid, etc.) live at the dispatcher layer (Phase 8.3),
 * not here — onboarding records the data, dispatch enforces the policy.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `YYYY-MM-DD` calendar date; matches the Postgres `date` column type. */
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be YYYY-MM-DD');

/** Pragmatic upper bound for a real-world license number; the column has no limit. */
const LicenseNumber = z
  .string()
  .min(4, 'license number must be at least 4 characters')
  .max(64, 'license number must be at most 64 characters');

/**
 * US state license plates max at ~8 chars; pad to 16 to cover personalised
 * plates and the rare two-line format that arrives joined.
 */
const Plate = z.string().min(1).max(16);

/**
 * Vehicle model years that an onboarded delivery vehicle could plausibly
 * carry — wide enough for a vintage restoration, narrow enough to catch
 * a year typo (1899 or 3024).
 */
const VehicleYear = z.coerce.number().int().min(1980).max(2100);

/** R2 object key for the insurance PDF. The column itself is nullable. */
const InsuranceDocKey = z.string().min(1).max(500);

/**
 * Reference returned by the background-check vendor (Checkr today). The
 * exact format is opaque to us; the column stores the string verbatim
 * so a future audit can re-query the vendor.
 */
const BackgroundCheckRef = z.string().min(1).max(128);

export const CreateDriverRequestSchema = z
  .object({
    userId: z.string().uuid(),
    licenseNumber: LicenseNumber,
    vehicleMake: z.string().min(1).max(100).nullable().optional(),
    vehicleModel: z.string().min(1).max(100).nullable().optional(),
    vehicleYear: VehicleYear.nullable().optional(),
    vehiclePlate: Plate.nullable().optional(),
    vehicleColor: z.string().min(1).max(50).nullable().optional(),
    insuranceDocKey: InsuranceDocKey.nullable().optional(),
    insuranceExpiresAt: ISODate.nullable().optional(),
    backgroundCheckPassedAt: ISODate.nullable().optional(),
    backgroundCheckProviderRef: BackgroundCheckRef.nullable().optional(),
  })
  .strict();

export type CreateDriverRequest = z.infer<typeof CreateDriverRequestSchema>;

export class CreateDriverRequestDto extends createZodDto(CreateDriverRequestSchema) {}

export const PatchDriverRequestSchema = z
  .object({
    vehicleMake: z.string().min(1).max(100).nullable().optional(),
    vehicleModel: z.string().min(1).max(100).nullable().optional(),
    vehicleYear: VehicleYear.nullable().optional(),
    vehiclePlate: Plate.nullable().optional(),
    vehicleColor: z.string().min(1).max(50).nullable().optional(),
    insuranceDocKey: InsuranceDocKey.nullable().optional(),
    insuranceExpiresAt: ISODate.nullable().optional(),
    backgroundCheckPassedAt: ISODate.nullable().optional(),
    backgroundCheckProviderRef: BackgroundCheckRef.nullable().optional(),
  })
  .strict();

export type PatchDriverRequest = z.infer<typeof PatchDriverRequestSchema>;

export class PatchDriverRequestDto extends createZodDto(PatchDriverRequestSchema) {}
