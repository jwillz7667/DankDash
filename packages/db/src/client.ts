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
  /**
   * Per-statement runtime cap (ms). Postgres aborts any single query
   * that exceeds this. Set 0 to disable (workers can opt out for legitimate
   * multi-minute batch jobs). Default 30s matches migration 0006's
   * database-level default — application-layer enforcement is the
   * authoritative copy when the DB-level ALTER DATABASE is unavailable
   * (managed Postgres revokes ALTER DATABASE in some plans).
   */
  readonly statementTimeoutMs?: number;
  /**
   * How long an open transaction is allowed to sit idle (ms) before
   * Postgres terminates the session. Defends against the
   * "BEGIN; ...await something forever..." anti-pattern that pins a
   * connection. 0 disables. Default 60s.
   */
  readonly idleInTransactionTimeoutMs?: number;
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
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_IN_TXN_TIMEOUT_MS = 60_000;

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
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const idleInTxnTimeoutMs = opts.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TXN_TIMEOUT_MS;
  const usePrepared = opts.prepare ?? true;
  const logger = opts.logger;

  // postgres-js `connection` is the libpq-style startup parameters bag;
  // each new physical socket runs `SET <key> = <value>` once. Encoded as
  // strings because postgres-js stringifies and pg parses GUC units from
  // the literal — `'30000'` is interpreted as ms (the default unit for
  // statement_timeout / idle_in_transaction_session_timeout).
  const connection: Record<string, string> = {};
  if (statementTimeoutMs > 0) {
    connection['statement_timeout'] = String(statementTimeoutMs);
  }
  if (idleInTxnTimeoutMs > 0) {
    connection['idle_in_transaction_session_timeout'] = String(idleInTxnTimeoutMs);
  }

  const sql = postgres(opts.databaseUrl, {
    max: maxConnections,
    prepare: usePrepared,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: idleTimeoutSeconds,
    connection,
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
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs: env.DATABASE_IDLE_IN_TXN_TIMEOUT_MS,
  });
}
