/**
 * Vitest globalSetup for apps/api. Runs ONCE per `pnpm test` invocation
 * (NOT per worker, NOT per file). Boots a single Postgres+PostGIS
 * testcontainer, runs migrations, and exports the connection string via
 * `process.env.DATABASE_URL` + `process.env.TEST_DATABASE_URL`. Forked
 * workers inherit those vars, so any test that builds the NestJS app
 * picks up the real container automatically — no per-test wiring needed.
 *
 * The bootstrap test (which never hits the DB) does not pay the boot
 * cost a second time — globalSetup is module-shared.
 *
 * Setting DATABASE_URL BEFORE env-setup.ts runs (env-setup uses `??=`
 * so it only defaults missing vars) is what makes this work without
 * touching every test file.
 */
import { setupTestDb, type TestDatabase } from '@dankdash/db/testing';

let testDb: TestDatabase | undefined;

export default async function (): Promise<() => Promise<void>> {
  // VITEST_SKIP_TESTCONTAINER=1 lets pure-unit-test runs (fakes only, no
  // Drizzle / no AppModule) bypass the Postgres container boot. Integration
  // tests that build the real AppModule still need the container, so this
  // is opt-in per-invocation, not a default. CI never sets it.
  if (process.env['VITEST_SKIP_TESTCONTAINER'] === '1') {
    return async () => {
      /* no-op */
    };
  }
  testDb = await setupTestDb();
  process.env['DATABASE_URL'] = testDb.connectionString;
  process.env['TEST_DATABASE_URL'] = testDb.connectionString;
  return async () => {
    if (testDb !== undefined) {
      await testDb.stop();
      testDb = undefined;
    }
  };
}
