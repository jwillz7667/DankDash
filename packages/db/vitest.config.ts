import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Container boot + migrations take ~15s on cold runs; give a generous
    // budget so CI does not flake on slow Docker pulls.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Single-process — the test container is shared via globalSetup so
    // parallel files would just queue on the same Postgres anyway. We could
    // run files concurrently but data-mutating tests would race on shared
    // tables; singleFork keeps the model simple and matches CI's slow disks.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globalSetup: ['./test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/migrate.cli.ts',
        'src/seed.cli.ts',
        'src/migrations/**',
        // Schema files are pure declarations; coverage % is misleading.
        'src/schema/**',
      ],
      thresholds: {
        // Repositories + seed are the meat; we hit 80%+ via the integration
        // suite. Lowered branches because many "if (row === undefined)
        // throw RepositoryError" branches are unreachable under healthy DB.
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 60,
      },
    },
  },
});
