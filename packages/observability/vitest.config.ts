import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // Barrels and side-effect-only modules have no behavior to cover.
      exclude: [
        'src/index.ts',
        'src/context/index.ts',
        'src/logging/index.ts',
        'src/metrics/index.ts',
        'src/otel/index.ts',
        'src/errors/index.ts',
        // The OTel SDK bootstrap reaches into the global process; covered
        // by integration tests in api/realtime/workers, not here.
        'src/otel/sdk.ts',
        'src/otel/shutdown.ts',
      ],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
