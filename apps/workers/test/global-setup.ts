// Vitest globalSetup for apps/workers integration tests. Boots one
// Postgres+PostGIS testcontainer (shared across every test file via
// singleFork) and exposes the connection string through
// TEST_DATABASE_URL. Mirrors apps/api/test/global-setup.ts.
//
// Unit tests colocated with source never touch TEST_DATABASE_URL, so
// they pay zero container-boot cost.
import { setupTestDb, type TestDatabase } from '@dankdash/db/testing';

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
