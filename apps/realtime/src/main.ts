/**
 * apps/realtime entrypoint.
 *
 * Boots the realtime server: validate env, construct the pino logger
 * (with the canonical PII redactions from @dankdash/config/logger),
 * open a slim Postgres pool for membership lookups, build the
 * Socket.io + stream-consumer graph via server.ts, and start
 * listening on $PORT. SIGTERM triggers graceful shutdown — drain the
 * stream consumer, close the io server, close the Postgres pool.
 */
import { createLogger } from '@dankdash/config';
import { createPool } from '@dankdash/db';
import { loadRealtimeEnv } from './env.js';
import { buildServer } from './server.js';

async function bootstrap(): Promise<void> {
  const env = loadRealtimeEnv({
    allowPartial: process.env['ALLOW_PARTIAL_ENV'] === '1',
  });
  const logger = createLogger({
    name: 'apps/realtime',
    level: env.LOG_LEVEL,
    environment: env.NODE_ENV,
  });

  const pool = createPool({
    databaseUrl: env.DATABASE_URL,
    logger,
    maxConnections: env.DATABASE_POOL_SIZE,
    slowQueryThresholdMs: env.DATABASE_SLOW_QUERY_MS,
  });

  const server = await buildServer({ env, pool, logger });
  await server.listen(env.PORT);
  logger.info(
    { event: 'realtime.listening', port: env.PORT, environment: env.NODE_ENV },
    'apps/realtime listening',
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ event: 'realtime.shutdown', signal }, 'apps/realtime shutting down');
    try {
      await server.close();
      await pool.close();
      process.exit(0);
    } catch (err) {
      logger.error(
        {
          event: 'realtime.shutdown.failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'apps/realtime shutdown failed',
      );
      process.exit(1);
    }
  };
  process.on('SIGTERM', (sig) => void shutdown(sig));
  process.on('SIGINT', (sig) => void shutdown(sig));
}

bootstrap().catch((err: unknown) => {
  // Bootstrap fails BEFORE the structured logger is wired (bad env,
  // unreachable Postgres). Stderr is the only sink guaranteed to reach
  // Railway's log stream.
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  process.stderr.write(`apps/realtime fatal bootstrap error: ${message}\n`);
  process.exit(1);
});
