/**
 * /v1/me DTOs.
 *
 *   GET   /v1/me   — returns the authenticated user, derived flags
 *                    (kycVerified, mfaEnabled), and optionally the
 *                    primary delivery address when one exists.
 *
 *   PATCH /v1/me   — narrow surface for self-service profile edits.
 *                    Email/phone/DOB changes are deliberately NOT
 *                    permitted here — those require step-up flows
 *                    (re-verification, re-KYC) that go through dedicated
 *                    endpoints in Phase 5+.
 *
 * The PATCH DTO uses `.partial()` so the client may send any subset of
 * the editable fields. `.strict()` still rejects unknown keys, so a
 * client that accidentally sends `email` gets a clear validation error
 * rather than a silent ignore.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { UserRoleSchema, UserStatusSchema } from '../../auth/dto/user-summary.dto.js';

export const MeResponseSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    phone: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    role: UserRoleSchema,
    status: UserStatusSchema,
    kycVerified: z.boolean(),
    kycVerifiedAt: z.string().datetime({ offset: true }).nullable(),
    mfaEnabled: z.boolean(),
    lastLoginAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type MeResponse = z.infer<typeof MeResponseSchema>;

export const UpdateMeRequestSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
  })
  .strict()
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field must be provided',
  });

export class UpdateMeRequestDto extends createZodDto(UpdateMeRequestSchema) {}
