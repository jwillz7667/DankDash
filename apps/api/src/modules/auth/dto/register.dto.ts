/**
 * POST /v1/auth/register
 *
 * Creates a new customer account in `pending_kyc` status, hashes the
 * password with argon2id + pepper, and issues an immediate token pair so
 * the iOS client can proceed straight to the KYC hand-off — Minnesota law
 * doesn't permit purchase before age 21 is verified, but the account
 * itself can exist beforehand.
 *
 * Password rules: at least 12 characters with at least one digit and one
 * letter. Deliberately not maximalist (no required symbols, no upper/lower
 * split) — NIST SP 800-63B recommends length + breach-corpus checks over
 * complexity rules. Breach-corpus check happens server-side in the auth
 * service; this DTO only enforces the cheap structural floor.
 *
 * Phone is E.164. DOB is a calendar date in YYYY-MM-DD; we accept the
 * client-claimed value here but it is NOT trusted — the real age check
 * runs off the verified DOB returned from Persona (PersonaService.handleWebhook).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TokenPairSchema } from './tokens.dto.js';
import { UserSummarySchema } from './user-summary.dto.js';

const PHONE_E164 = /^\+[1-9]\d{1,14}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PASSWORD_HAS_LETTER = /[A-Za-z]/u;
const PASSWORD_HAS_DIGIT = /\d/u;

export const RegisterRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z
      .string()
      .min(12, { message: 'password must be at least 12 characters' })
      .max(256)
      .refine((pw) => PASSWORD_HAS_LETTER.test(pw) && PASSWORD_HAS_DIGIT.test(pw), {
        message: 'password must contain at least one letter and one digit',
      }),
    phone: z
      .string()
      .regex(PHONE_E164, { message: 'phone must be E.164 (e.g. +14155551234)' })
      .optional(),
    dateOfBirth: z.string().regex(ISO_DATE, { message: 'dateOfBirth must be YYYY-MM-DD' }),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
  })
  .strict();

export class RegisterRequestDto extends createZodDto(RegisterRequestSchema) {}

export const RegisterResponseSchema = z
  .object({
    user: UserSummarySchema,
    tokens: TokenPairSchema,
  })
  .strict();

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;
