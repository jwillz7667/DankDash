/**
 * Token-pair contract shared by /auth/login, /auth/register, /auth/refresh,
 * and /auth/mfa/verify. Issued every time the server mints a new access
 * token, regardless of which endpoint requested it — keeping the client
 * shape uniform avoids a per-endpoint branch in the iOS keychain layer.
 *
 * `accessToken` is the short-lived RS256 JWT (15 min by default; see
 * JwtService). `refreshToken` is the opaque 256-bit random value returned
 * once at issuance — only its SHA-256 hash is stored server-side, so a
 * compromised DB read alone does not yield a usable refresh token.
 */
import { z } from 'zod';

export const TokenPairSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessTokenExpiresAt: z.string().datetime({ offset: true }),
    refreshTokenExpiresAt: z.string().datetime({ offset: true }),
    tokenType: z.literal('Bearer'),
  })
  .strict();

export type TokenPair = z.infer<typeof TokenPairSchema>;
