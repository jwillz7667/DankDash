import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // The barrel and the type/enum-only modules carry no behaviour to
      // cover; the order machine and the error class are the contract that
      // gates every transition and must hit 100% per the Phase 7 DoD.
      exclude: ['src/index.ts', 'src/states.ts', 'src/events.ts'],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
