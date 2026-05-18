import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // index.ts is a barrel and types.ts is interface-only — no behaviour
      // to cover. Everything else is in the money path and must hit 100%
      // per CLAUDE.md non-negotiables (a regression here is silently
      // incorrect customer charges).
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
