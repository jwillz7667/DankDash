/**
 * /v1/auth/mfa/* DTOs.
 *
 * Three concrete endpoints map onto the four-method MfaService lifecycle:
 *
 *   POST /v1/auth/mfa/setup     → MfaService.beginEnrollment (no body in,
 *                                  secret + otpauth URL out — NOT yet
 *                                  persisted; the client holds the secret
 *                                  in memory until /confirm).
 *
 *   POST /v1/auth/mfa/confirm   → MfaService.confirmEnrollment (body =
 *                                  the secret the client was shown plus a
 *                                  fresh TOTP code; server verifies the
 *                                  code matches the secret, then encrypts
 *                                  and persists).
 *
 *   POST /v1/auth/mfa/verify    → MfaService.verifyCode (used by step-up
 *                                  flows or as the second factor in
 *                                  /auth/login when the user already
 *                                  enrolled).
 *
 *   POST /v1/auth/mfa/disable   → MfaService.disable (gated on a current
 *                                  code so a stolen access token alone
 *                                  cannot strip the second factor).
 *
 * `disable` is a deliberate extension to the spec — leaving an enrolled
 * user with no way to recover would itself be a security problem if a
 * device was lost. Backup codes (Phase 5+) will live behind the same
 * disable / regenerate semantics.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const TOTP_CODE = /^\d{6}$/u;
// RFC 4648 base32 alphabet — uppercase letters + digits 2-7, optional padding.
const BASE32 = /^[A-Z2-7]+=*$/u;

export const MfaSetupResponseSchema = z
  .object({
    secretBase32: z.string().regex(BASE32),
    otpauthUrl: z.string().url(),
  })
  .strict();

export type MfaSetupResponse = z.infer<typeof MfaSetupResponseSchema>;

export const MfaConfirmRequestSchema = z
  .object({
    secretBase32: z.string().regex(BASE32),
    code: z.string().regex(TOTP_CODE, { message: 'code must be exactly 6 digits' }),
  })
  .strict();

export class MfaConfirmRequestDto extends createZodDto(MfaConfirmRequestSchema) {}

export const MfaVerifyRequestSchema = z
  .object({
    code: z.string().regex(TOTP_CODE, { message: 'code must be exactly 6 digits' }),
  })
  .strict();

export class MfaVerifyRequestDto extends createZodDto(MfaVerifyRequestSchema) {}

export const MfaDisableRequestSchema = z
  .object({
    code: z.string().regex(TOTP_CODE, { message: 'code must be exactly 6 digits' }),
  })
  .strict();

export class MfaDisableRequestDto extends createZodDto(MfaDisableRequestSchema) {}
