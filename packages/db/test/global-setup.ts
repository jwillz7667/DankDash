/**
 * Vitest globalSetup — runs ONCE per `pnpm test` invocation, regardless of
 * how many test files exist. Boots a single Postgres+PostGIS testcontainer,
 * runs migrations, exposes the URL via `process.env.TEST_DATABASE_URL`, and
 * returns a teardown that stops the container at the end of the run.
 */
// The testcontainers harness is colocated with the db package so a) it has
// direct access to the migrations dir without indirection and b) the build
// graph stays acyclic (test-utils depends on db, not the other way around).
// Use a relative import here so the self-reference works even before
// `pnpm build` has produced `dist/testing/index.d.ts` — the package-name
// alias `@dankdash/db/testing` only resolves against the built artifacts.
import { setupTestDb, type TestDatabase } from '../src/testing/postgres-container.js';

let testDb: TestDatabase | undefined;

export default async function (): Promise<() => Promise<void>> {
  testDb = await setupTestDb();
  process.env['TEST_DATABASE_URL'] = testDb.connectionString;
  return async () => {
    if (testDb !== undefined) {
      await testDb.stop();
      testDb = undefined;
    }
  };
}
