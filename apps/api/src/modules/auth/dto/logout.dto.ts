/**
 * POST /v1/auth/logout
 *
 * Revokes the presented refresh token (and only that token — multi-device
 * sign-out is a separate endpoint). The access token is not invalidated
 * server-side since it is short-lived and self-contained; clients must
 * drop it from storage on receiving 204.
 *
 * Accepting the refresh token in the body rather than reading it from the
 * Authorization header lets the iOS client log out even after the access
 * token has expired — a common case when the user backgrounded the app
 * and returned later just to sign out.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LogoutRequestSchema = z
  .object({
    refreshToken: z.string().min(32).max(512),
  })
  .strict();

export class LogoutRequestDto extends createZodDto(LogoutRequestSchema) {}
