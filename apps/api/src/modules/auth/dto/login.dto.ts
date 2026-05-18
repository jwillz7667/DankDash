/**
 * POST /v1/auth/login
 *
 * Two-step login when MFA is enabled: the first call without `mfaCode`
 * returns `{ mfaRequired: true }` instead of a token pair. The client then
 * collects the TOTP from the user and re-issues the same request with
 * `mfaCode` populated. This avoids a separate session-storage layer
 * holding "half-authenticated" state on the server.
 *
 * For users without MFA, a single call returns the token pair directly.
 *
 * Rate-limit defence is delegated to @nestjs/throttler (Phase 2.6) — this
 * DTO intentionally has no lockout logic, since structural validation
 * should not branch on policy.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TokenPairSchema } from './tokens.dto.js';
import { UserSummarySchema } from './user-summary.dto.js';

export const LoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(256),
    mfaCode: z
      .string()
      .regex(/^\d{6}$/u, { message: 'mfaCode must be exactly 6 digits' })
      .optional(),
  })
  .strict();

export class LoginRequestDto extends createZodDto(LoginRequestSchema) {}

const LoginSuccessResponseSchema = z
  .object({
    status: z.literal('authenticated'),
    user: UserSummarySchema,
    tokens: TokenPairSchema,
  })
  .strict();

const LoginMfaRequiredResponseSchema = z
  .object({
    status: z.literal('mfa_required'),
    /**
     * Opaque challenge identifier the client echoes back when retrying with
     * the TOTP code. Lets the server tie the second-factor attempt to the
     * password-verified context without holding interim state for any
     * caller that lost interest after the first call.
     */
    challengeId: z.string().uuid(),
    challengeExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const LoginResponseSchema = z.discriminatedUnion('status', [
  LoginSuccessResponseSchema,
  LoginMfaRequiredResponseSchema,
]);

export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type LoginSuccessResponse = z.infer<typeof LoginSuccessResponseSchema>;
export type LoginMfaRequiredResponse = z.infer<typeof LoginMfaRequiredResponseSchema>;
