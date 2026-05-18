/**
 * Testcontainers harness for integration tests that need a real Postgres +
 * PostGIS instance. Co-located with the schema and migration runner so any
 * package can do `import { setupTestDb } from '@dankdash/db/testing'`.
 *
 * Boot order:
 *   1. Start `postgis/postgis:16-3.4` (or override via TEST_POSTGRES_IMAGE).
 *   2. Wait for `pg_isready`.
 *   3. Enable required extensions (postgis, pg_trgm, pgcrypto, citext,
 *      uuid-ossp, btree_gin) — testcontainers fresh images don't run the
 *      docker-compose initdb scripts.
 *   4. Apply Drizzle migrations from `packages/db/src/migrations`.
 *
 * Boot is slow (~10–15s cold) so tests should share a single TestDatabase per
 * suite — the test runner spins one up in `beforeAll` and tears it down in
 * `afterAll`. For per-test isolation, wrap each test in `withTransaction`
 * from @dankdash/test-utils.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino, type Logger } from 'pino';
import { createPool, type Pool } from '../client.js';
import { runMigrations } from '../migrate.js';

const DEFAULT_IMAGE = 'postgis/postgis:16-3.4';
const REQUIRED_EXTENSIONS = [
  'postgis',
  'pg_trgm',
  'pgcrypto',
  'citext',
  'uuid-ossp',
  'btree_gin',
] as const;

export interface SetupTestDbOptions {
  /** Override the container image. Defaults to `postgis/postgis:16-3.4`. */
  readonly image?: string;
  /**
   * Override the migrations directory. Defaults to the bundled @dankdash/db
   * migrations dir resolved relative to this file.
   */
  readonly migrationsDir?: string;
  /**
   * Optional logger. Defaults to a silent pino instance (level: 'silent') so
   * test output stays clean.
   */
  readonly logger?: Logger;
  /**
   * Whether to apply migrations after the container is ready. Default true.
   * Set false if a test wants to start from a totally empty database.
   */
  readonly applyMigrations?: boolean;
}

export interface TestDatabase {
  /** The Drizzle database instance — primary handle for repositories. */
  readonly db: Pool['db'];
  /** Raw postgres-js Sql for ad-hoc SQL (extension setup, truncation, etc). */
  readonly sql: Pool['sql'];
  /** Full pool with `close` and `timed`. */
  readonly pool: Pool;
  /** Resolved connection string for libraries that want it directly. */
  readonly connectionString: string;
  /** Re-apply migrations against the current container. */
  readonly applyMigrations: () => Promise<void>;
  /**
   * Truncate every application table while preserving the schema. Useful
   * between suites that share a container but want a clean slate without
   * paying the container-boot cost again.
   */
  readonly truncateAll: () => Promise<void>;
  /** Tear down: close the pool, then stop and remove the container. */
  readonly stop: () => Promise<void>;
}

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

async function enableExtensions(pool: Pool): Promise<void> {
  for (const ext of REQUIRED_EXTENSIONS) {
    await pool.sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}";`);
  }
}

function resolveMigrationsDir(override: string | undefined): string {
  if (override !== undefined) return override;
  // From dist/testing/postgres-container.js (or src/testing/postgres-container.ts
  // when running via tsx), walk one level up to packages/db/{dist,src} and
  // hop to ./migrations. We deliberately keep migration SQL out of the build
  // copy step's path computation here — runtime callers pass `dist/migrations`
  // when invoked from a built consumer; this default targets in-repo testing.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'migrations');
}

export async function setupTestDb(opts: SetupTestDbOptions = {}): Promise<TestDatabase> {
  const image = opts.image ?? DEFAULT_IMAGE;
  const logger = opts.logger ?? silentLogger();
  const shouldMigrate = opts.applyMigrations ?? true;

  const container = await new PostgreSqlContainer(image)
    .withUsername('test')
    .withPassword('test')
    .withDatabase('test')
    // `prepare: false` on the client; on the server side we disable JIT to
    // make small queries faster and more predictable in tests.
    .withCommand(['postgres', '-c', 'jit=off', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .start();

  const connectionString = container.getConnectionUri();

  // Pool with prepare:false so transaction-rollback isolation works cleanly
  // (prepared statements survive ROLLBACK and confuse test ordering).
  const pool = createPool({
    databaseUrl: connectionString,
    logger,
    maxConnections: 4,
    prepare: false,
    slowQueryThresholdMs: 10_000,
  });

  await enableExtensions(pool);

  const migrationsDir = resolveMigrationsDir(opts.migrationsDir);

  async function applyMigrations(): Promise<void> {
    await runMigrations({ databaseUrl: connectionString, migrationsDir, logger });
  }

  if (shouldMigrate) {
    await applyMigrations();
  }

  async function truncateAll(): Promise<void> {
    const rows = await pool.sql<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT LIKE '_drizzle_%'
        AND tablename NOT LIKE 'order_events_%'
        AND tablename NOT LIKE 'driver_location_history_%'
        AND tablename NOT LIKE 'notifications_%'
        AND tablename NOT LIKE 'audit_log_%'
    `;
    if (rows.length === 0) return;
    const idents = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await pool.sql.unsafe(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE;`);
  }

  async function stop(): Promise<void> {
    try {
      await pool.close();
    } finally {
      await stopContainer(container);
    }
  }

  return {
    db: pool.db,
    sql: pool.sql,
    pool,
    connectionString,
    applyMigrations,
    truncateAll,
    stop,
  };
}

async function stopContainer(container: StartedPostgreSqlContainer): Promise<void> {
  await container.stop({ remove: true, removeVolumes: true });
}
