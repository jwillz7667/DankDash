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
// MUST be the first non-type import — `initOtel` patches `require` for
// ioredis/pg/fastify/socket.io at module-load time, so loading any of
// those before this line (directly or via `./server.js`) silently
// disables instrumentation. Lint rule disabled locally to preserve
// the order.
/* eslint-disable import/order */
import { realtimeOtelHandle } from './tracing.js';
import { createLogger } from '@dankdash/config';
import { createPool } from '@dankdash/db';
import { loadRealtimeEnv } from './env.js';
import { buildServer } from './server.js';
/* eslint-enable import/order */

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

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'realtime.shutdown', signal }, 'apps/realtime shutting down');
    try {
      await server.close();
      await pool.close();
      // Flush OTel batch before exit. Railway grants a 30s SIGTERM
      // window; the SDK's default batch span processor would otherwise
      // drop the last few seconds of spans.
      await realtimeOtelHandle.shutdown();
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
