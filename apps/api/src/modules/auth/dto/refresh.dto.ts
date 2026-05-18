/**
 * POST /v1/auth/refresh
 *
 * Atomically rotates a refresh token: the presented value is marked
 * `rotated_to=<newSessionId>` and a new (familyId-preserving) row is
 * inserted. Reuse of the previously-rotated value triggers cascade
 * revocation of the entire family — see RefreshTokenService.
 *
 * The DTO accepts the opaque token verbatim; hashing happens in the
 * service, never on the wire. We reject empty / too-short values cheaply
 * so the service never has to handle obvious garbage.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TokenPairSchema } from './tokens.dto.js';

export const RefreshRequestSchema = z
  .object({
    refreshToken: z.string().min(32, { message: 'refreshToken looks malformed' }).max(512),
  })
  .strict();

export class RefreshRequestDto extends createZodDto(RefreshRequestSchema) {}

export const RefreshResponseSchema = z
  .object({
    tokens: TokenPairSchema,
  })
  .strict();

export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
