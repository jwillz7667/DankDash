import { defineConfig } from 'vitest/config';

// Realtime suite spins one Redis testcontainer per process via globalSetup
// and reuses it across every spec file (singleFork). XADD/XREADGROUP
// state is namespaced per-suite via the consumer-group name so individual
// tests do not interfere — see test/harness.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
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
