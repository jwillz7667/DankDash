#!/usr/bin/env node
import { pino } from 'pino';
import { createPool } from './client.js';
import { seed } from './seed.js';

interface CliEnv {
  readonly DATABASE_URL?: string;
  readonly DANKDASH_SEED_TRUNCATE?: string;
  readonly LOG_LEVEL?: string;
  readonly NODE_ENV?: string;
}

async function main(): Promise<number> {
  const env = process.env as unknown as CliEnv;
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
    process.stderr.write('seed: DATABASE_URL is required\n');
    return 2;
  }

  const isProduction = env.NODE_ENV === 'production';
  const loggerOpts = isProduction
    ? { level: env.LOG_LEVEL ?? 'info' }
    : {
        level: env.LOG_LEVEL ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
      };
  const logger = pino(loggerOpts);

  if (isProduction) {
    logger.error('seed: refusing to run in production (NODE_ENV=production)');
    return 2;
  }

  // Default true; opt out with DANKDASH_SEED_TRUNCATE=false for incremental dev use.
  const truncate = env.DANKDASH_SEED_TRUNCATE !== 'false';

  const pool = createPool({ databaseUrl: env.DATABASE_URL, logger });
  try {
    logger.warn({ truncate }, 'seed: starting (DESTRUCTIVE — wipes domain tables)');
    const summary = await seed({ db: pool.db, logger, truncate });
    logger.info(summary, 'seed: done');
    return 0;
  } catch (error) {
    logger.error({ err: error }, 'seed: failed');
    return 1;
  } finally {
    await pool.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(`seed: unhandled ${String(error)}\n`);
    process.exit(1);
  });
