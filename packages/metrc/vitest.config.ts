import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // Barrel + pure type/Zod declaration files have no executable
      // branches worth gating on. Everything else must hit 100% — the
      // compliance/traceability surface is held to the same bar as
      // @dankdash/compliance and @dankdash/aeropay (CLAUDE.md
      // non-negotiables).
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
