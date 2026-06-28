/**
 * Vitest globalSetup for apps/api. Runs ONCE per `pnpm test` invocation
 * (NOT per worker, NOT per file). Boots a single Postgres+PostGIS
 * testcontainer AND a single Redis 7 testcontainer, runs migrations, and
 * exports the connection strings via `process.env`. Forked workers inherit
 * those vars, so any test that builds the NestJS app picks up the real
 * containers automatically — no per-test wiring needed.
 *
 * The bootstrap test (which never hits the DB) does not pay the boot
 * cost a second time — globalSetup is module-shared.
 *
 * Setting DATABASE_URL / REDIS_URL here (via direct assignment, BEFORE
 * env-setup.ts runs — env-setup uses `??=` so it only defaults missing
 * vars) is what makes this work without touching every test file. The
 * direct assignment also DELIBERATELY overrides any ambient REDIS_URL /
 * DATABASE_URL the runtime injected (e.g. a deployment's production
 * connection strings): integration tests that boot AppModule wire real
 * ioredis clients (catalog cache, realtime listeners, notification dedup,
 * the rate-limit fallback) and the checkout / payment-webhook / refund
 * flows `await` Redis round-trips inside the request transaction — if
 * REDIS_URL pointed at an unreachable host those suites would fail (and
 * spew `getaddrinfo ENOTFOUND` while ioredis retried). Pinning both to a
 * throwaway container makes the api suite hermetic regardless of the host
 * environment, mirroring the Redis-container pattern in apps/realtime and
 * apps/workers.
 */
import { setupTestDb, type TestDatabase } from '@dankdash/db/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

let testDb: TestDatabase | undefined;
let redis: StartedTestContainer | undefined;

export default async function (): Promise<() => Promise<void>> {
  // VITEST_SKIP_TESTCONTAINER=1 lets pure-unit-test runs (fakes only, no
  // Drizzle / no AppModule) bypass the container boots. Integration tests
  // that build the real AppModule still need both containers, so this is
  // opt-in per-invocation, not a default. CI never sets it.
  if (process.env['VITEST_SKIP_TESTCONTAINER'] === '1') {
    return async () => {
      /* no-op */
    };
  }

  // Boot Postgres + Redis concurrently — independent containers, so there
  // is no reason to pay their startup latency serially.
  const [db, redisContainer] = await Promise.all([
    setupTestDb(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withStartupTimeout(60_000)
      .start(),
  ]);
  testDb = db;
  redis = redisContainer;

  process.env['DATABASE_URL'] = db.connectionString;
  process.env['TEST_DATABASE_URL'] = db.connectionString;
  process.env['REDIS_URL'] = `redis://${redisContainer.getHost()}:${String(
    redisContainer.getMappedPort(6379),
  )}`;

  return async () => {
    await Promise.all([
      testDb !== undefined ? testDb.stop() : Promise.resolve(),
      redis !== undefined ? redis.stop() : Promise.resolve(),
    ]);
    testDb = undefined;
    redis = undefined;
  };
}
