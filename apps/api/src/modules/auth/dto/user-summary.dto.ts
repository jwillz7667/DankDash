/**
 * The minimal user shape returned alongside any auth response that mints a
 * session — register, login, refresh (after step-up). Mirrors the columns
 * the iOS keychain layer needs to render the post-login UI without a
 * follow-up /me round-trip.
 *
 * Restricted columns (mfa_secret_enc, password_hash, kyc_provider_ref, raw
 * DOB) are deliberately absent. /me may surface a subset of derived
 * indicators (kycVerified, mfaEnabled) but never the underlying secrets.
 */
import { z } from 'zod';

export const UserRoleSchema = z.enum([
  'customer',
  'budtender',
  'manager',
  'owner',
  'driver',
  'admin',
  'superadmin',
]);
export type UserRoleDto = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['pending_kyc', 'active', 'suspended', 'banned']);
export type UserStatusDto = z.infer<typeof UserStatusSchema>;

export const UserSummarySchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    phone: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    role: UserRoleSchema,
    status: UserStatusSchema,
    kycVerified: z.boolean(),
    mfaEnabled: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type UserSummary = z.infer<typeof UserSummarySchema>;
