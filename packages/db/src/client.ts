/**
 * Postgres connection pool + typed Drizzle instance.
 *
 * The pool is the single point of contact between application code and
 * Postgres. Use `createPool` for fine-grained control (tests, scripts) or
 * `createPoolFromEnv` for the standard app boot path.
 *
 * Slow-query telemetry is opt-in via the `timed()` helper. Repositories wrap
 * their queries with `timed('users.findById', () => db.select()...)`; the
 * helper warns when a single call exceeds `slowQueryThresholdMs` (default
 * 500ms, configurable via DATABASE_SLOW_QUERY_MS).
 */
import { type Env } from '@dankdash/config';
import { type Logger as DrizzleLogger } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';
import type { Logger } from 'pino';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface CreatePoolOptions {
  readonly databaseUrl: string;
  readonly logger: Logger;
  readonly maxConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly slowQueryThresholdMs?: number;
  /**
   * Disable prepared-statement caching. Required for transaction-pooling
   * proxies (pgbouncer in tx mode) and the transactional rollback strategy
   * used by integration tests.
   */
  readonly prepare?: boolean;
}

export interface Pool {
  readonly db: Database;
  readonly sql: Sql;
  readonly close: () => Promise<void>;
  readonly timed: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const DEFAULT_IDLE_TIMEOUT_S = 30;
const DEFAULT_SLOW_QUERY_MS = 500;

class PinoDrizzleLogger implements DrizzleLogger {
  constructor(private readonly logger: Logger) {}

  logQuery(query: string, params: unknown[]): void {
    this.logger.debug({ query, params }, 'sql query');
  }
}

export function createPool(opts: CreatePoolOptions): Pool {
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const connectTimeoutSeconds = opts.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_S;
  const idleTimeoutSeconds = opts.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S;
  const slowQueryThresholdMs = opts.slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_MS;
  const usePrepared = opts.prepare ?? true;
  const logger = opts.logger;

  const sql = postgres(opts.databaseUrl, {
    max: maxConnections,
    prepare: usePrepared,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: idleTimeoutSeconds,
    onnotice: (notice) => {
      logger.debug({ notice }, 'postgres notice');
    },
  });

  const db = drizzle(sql, { schema, logger: new PinoDrizzleLogger(logger) });

  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    try {
      return await fn();
    } finally {
      const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      if (elapsedMs >= slowQueryThresholdMs) {
        logger.warn(
          { label, elapsedMs, thresholdMs: slowQueryThresholdMs },
          'slow query exceeded threshold',
        );
      } else {
        logger.debug({ label, elapsedMs }, 'query completed');
      }
    }
  }

  async function close(): Promise<void> {
    await sql.end({ timeout: 5 });
  }

  return { db, sql, close, timed };
}

export function createPoolFromEnv(env: Env, logger: Logger): Pool {
  return createPool({
    databaseUrl: env.DATABASE_URL,
    logger,
    maxConnections: env.DATABASE_POOL_SIZE,
    slowQueryThresholdMs: env.DATABASE_SLOW_QUERY_MS,
  });
}
