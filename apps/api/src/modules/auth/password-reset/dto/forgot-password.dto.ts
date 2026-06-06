/**
 * POST /v1/auth/forgot-password
 *
 * Starts the email-delivered reset flow. The response is always 202 with no
 * body regardless of whether the email maps to an account — the endpoint must
 * not become an account-enumeration oracle. Email normalization (trim +
 * lowercase) matches the registration/login DTOs so the lookup hits the same
 * citext column the account was created against.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ForgotPasswordRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export class ForgotPasswordRequestDto extends createZodDto(ForgotPasswordRequestSchema) {}
