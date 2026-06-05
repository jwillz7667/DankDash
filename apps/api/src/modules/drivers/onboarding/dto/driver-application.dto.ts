/**
 * Driver-self onboarding DTOs.
 *
 *   POST /v1/driver/applications   — DriverApplicationRequest
 *                                    DriverApplicationResponse
 *
 * This is the self-service counterpart to the admin onboarding DTO
 * (`admin/dto/create-driver.dto.ts`). The two differ in one structural
 * way: the admin path takes a `userId` in the body (an operator
 * onboarding someone else), whereas the self path derives the user from
 * the authenticated principal — the request never carries a user id.
 *
 * Vehicle fields are all required here (the iOS review screen is gated
 * on a complete vehicle + license number), unlike the admin path where
 * they are optional. The license number arrives in plaintext over TLS
 * and is hashed inside the service — it is never stored or logged in
 * clear.
 *
 * `documents` carries the metadata the iOS client captured for each
 * required slot (driver's license, insurance, registration). The blob
 * bytes are NOT uploaded here — there is no presigned-upload surface in
 * the codebase yet, and the `storageKey` the client sends is a local
 * sandbox filename, not an R2 object key. The service validates the
 * manifest at the boundary but does not persist the keys; wiring the
 * real upload + `insuranceDocKey` linkage is a separate, future surface.
 * Keeping the field in the contract now means the client half is stable
 * the day that surface lands.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Wire-side document-kind discriminator. Matches the iOS `DocumentSlot`
 * raw values exactly — the client sends `kind: slot.rawValue`.
 */
export const ApplicationDocumentKindSchema = z.enum([
  'drivers_license',
  'vehicle_insurance',
  'vehicle_registration',
]);
export type ApplicationDocumentKind = z.infer<typeof ApplicationDocumentKindSchema>;

const ApplicationDocumentSchema = z
  .object({
    kind: ApplicationDocumentKindSchema,
    /** Local sandbox filename today; an R2 key once uploads land. */
    storageKey: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(127),
    /** 50 MB ceiling — a scanned ID / insurance PDF is well under this. */
    sizeBytes: z.number().int().min(0).max(50_000_000),
  })
  .strict();

/**
 * US state plates max at ~8 chars; 16 covers personalised plates and the
 * rare two-line format that arrives joined. Matches the admin DTO bound.
 */
const Plate = z.string().min(1).max(16);

/** Same plausible-vehicle-year window the admin onboarding DTO enforces. */
const VehicleYear = z.number().int().min(1980).max(2100);

export const DriverApplicationRequestSchema = z
  .object({
    vehicleMake: z.string().min(1).max(100),
    vehicleModel: z.string().min(1).max(100),
    vehicleYear: VehicleYear,
    vehiclePlate: Plate,
    vehicleColor: z.string().min(1).max(50),
    licenseNumber: z
      .string()
      .min(4, 'license number must be at least 4 characters')
      .max(64, 'license number must be at most 64 characters'),
    documents: z.array(ApplicationDocumentSchema).min(1).max(10),
  })
  .strict();

export type DriverApplicationRequest = z.infer<typeof DriverApplicationRequestSchema>;

export class DriverApplicationRequestDto extends createZodDto(DriverApplicationRequestSchema) {}

/**
 * Submission receipt. `applicationId` is the `drivers.id` of the pending
 * row (the client stores it as the application handle and matches it
 * against `GET /v1/driver/me` once approved). `status` is `pending` from
 * a fresh submission and `approved` only in the idempotent re-submission
 * case where the row is already activated — the client re-routes to the
 * shift home on its next `me` poll. `queuePosition` is reserved for a
 * future ops-queue projection and is always null today.
 */
export const DriverApplicationResponseSchema = z
  .object({
    applicationId: z.string().uuid(),
    status: z.enum(['pending', 'approved']),
    queuePosition: z.number().int().min(0).nullable(),
  })
  .strict();

export type DriverApplicationResponse = z.infer<typeof DriverApplicationResponseSchema>;

export class DriverApplicationResponseDto extends createZodDto(DriverApplicationResponseSchema) {}
