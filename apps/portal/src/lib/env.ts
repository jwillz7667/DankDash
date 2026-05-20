/**
 * Portal env-var loader.
 *
 * Validates required public + private env at module load time with Zod.
 * Missing or malformed values throw a `ConfigError` and the process dies
 * before any request hits this module — the iOS spec of "fail fast at
 * boundaries" applies equally to a Next.js process.
 *
 * `NEXT_PUBLIC_*` vars are inlined by Next at build time and are visible
 * to the browser. Everything else stays server-side.
 */
import { ConfigError } from '@dankdash/types';
import { z } from 'zod';

const PublicEnvSchema = z
  .object({
    NEXT_PUBLIC_API_BASE_URL: z.string().url(),
    NEXT_PUBLIC_REALTIME_URL: z.string().url(),
  })
  .strict();

const ServerEnvSchema = z
  .object({
    AUTH_SECRET: z.string().min(32),
    INTERNAL_API_BASE_URL: z.string().url().optional(),
  })
  .passthrough();

export type PublicEnv = z.infer<typeof PublicEnvSchema>;
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/**
 * Reads the four `NEXT_PUBLIC_*` vars consumers may legitimately need on
 * both the server and the client. Throws a typed `ConfigError` on missing
 * values — the error's `details` carries the offending keys for a useful
 * stack at bootstrap.
 */
export function loadPublicEnv(source: NodeJS.ProcessEnv = process.env): PublicEnv {
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: source['NEXT_PUBLIC_API_BASE_URL'],
    NEXT_PUBLIC_REALTIME_URL: source['NEXT_PUBLIC_REALTIME_URL'],
  });
  if (!parsed.success) {
    throw new ConfigError('CONFIG_INVALID', 'portal public env is missing or malformed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse({
    AUTH_SECRET: source['AUTH_SECRET'],
    INTERNAL_API_BASE_URL: source['INTERNAL_API_BASE_URL'],
  });
  if (!parsed.success) {
    throw new ConfigError('CONFIG_INVALID', 'portal server env is missing or malformed', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Resolves the API base URL the server-side fetch path should use.
 *
 *   - In a typical Vercel deploy the portal Lambda talks to the API
 *     directly via the public hostname (NEXT_PUBLIC_API_BASE_URL).
 *   - In a Railway deploy where the portal pod can reach the API pod over
 *     the private network, `INTERNAL_API_BASE_URL` is set to e.g.
 *     `http://api.railway.internal:3000` so we skip the public TLS hop.
 */
export function resolveApiBaseUrl(server: ServerEnv, publicEnv: PublicEnv): string {
  return server.INTERNAL_API_BASE_URL ?? publicEnv.NEXT_PUBLIC_API_BASE_URL;
}
