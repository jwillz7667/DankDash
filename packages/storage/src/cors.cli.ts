/**
 * One-shot ops CLI that applies the R2 bucket CORS policy required for
 * browser direct-to-R2 uploads (presigned PUT). Without a matching CORS rule
 * the browser preflight is rejected before the PUT is sent, so every vendor
 * image upload fails regardless of a valid signature.
 *
 * Runs against the same R2 credentials the API uses. In production, invoke it
 * inside the api container (which has R2_* in its env), mirroring the DB
 * migrate CLI:
 *
 *   railway ssh --service @dankdash/api -- \
 *     node packages/storage/dist/cors.cli.js < /dev/null
 *
 * Allowed origins default to the portal's production + www domains and the
 * local dev origin, and can be overridden with a comma-separated
 * R2_CORS_ALLOWED_ORIGINS env var. Idempotent — it replaces the bucket CORS
 * configuration wholesale on each run.
 */
import { pino } from 'pino';
import { R2Storage, type R2Config } from './r2.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://dankdash.business',
  'https://www.dankdash.business',
  'http://localhost:3000',
] as const;

class MissingR2EnvError extends Error {
  public override readonly name = 'MissingR2EnvError';
  constructor(variable: string) {
    super(`${variable} is required to configure R2 bucket CORS.`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingR2EnvError(name);
  }
  return value;
}

function readAllowedOrigins(): readonly string[] {
  const raw = process.env['R2_CORS_ALLOWED_ORIGINS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

async function main(): Promise<void> {
  const logger = pino({ name: 'storage.cors' });

  const config: R2Config = {
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket: requireEnv('R2_BUCKET_NAME'),
  };
  const allowedOrigins = readAllowedOrigins();

  const storage = new R2Storage(config);
  await storage.putBucketCors(allowedOrigins);

  logger.info({ bucket: config.bucket, allowedOrigins }, 'applied R2 bucket CORS configuration');
}

main().catch((error: unknown) => {
  const logger = pino({ name: 'storage.cors' });
  logger.error(
    { err: error instanceof Error ? { name: error.name, message: error.message } : error },
    'failed to apply R2 bucket CORS configuration',
  );
  process.exitCode = 1;
});
