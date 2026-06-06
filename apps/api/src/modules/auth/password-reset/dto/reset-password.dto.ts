/**
 * POST /v1/auth/reset-password
 *
 * Completes the flow: the user submits the code they received by email plus a
 * new password. The code is the bearer credential — it alone identifies the
 * account, so no email is required here. On success the server updates the
 * password hash and revokes every session for the account (204 No Content).
 *
 * The password policy mirrors registration (≥12 chars, at least one letter and
 * one digit) so a reset can't downgrade an account below the floor enforced at
 * sign-up. `code` allows up to 64 chars to tolerate separators/whitespace; the
 * service normalizes it before hashing.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PASSWORD_HAS_LETTER = /[A-Za-z]/u;
const PASSWORD_HAS_DIGIT = /\d/u;

export const ResetPasswordRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    newPassword: z
      .string()
      .min(12, { message: 'password must be at least 12 characters' })
      .max(256)
      .refine((pw) => PASSWORD_HAS_LETTER.test(pw) && PASSWORD_HAS_DIGIT.test(pw), {
        message: 'password must contain at least one letter and one digit',
      }),
  })
  .strict();

export class ResetPasswordRequestDto extends createZodDto(ResetPasswordRequestSchema) {}
