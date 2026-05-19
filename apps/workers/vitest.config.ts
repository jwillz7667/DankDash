import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Include both unit tests colocated with source under src/jobs/**/*.test.ts
    // and integration suites under test/integration/**/*.test.ts. The
    // globalSetup below boots a single Postgres+PostGIS testcontainer when
    // any test file in the run pulls TEST_DATABASE_URL — unit-only runs
    // pay no boot cost because they never touch the env var.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Container boot + migrations land in 10–15s cold; mirror the budget the
    // db + api packages use so CI behaves consistently across pulls.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globalSetup: ['./test/global-setup.ts'],
  },
});
