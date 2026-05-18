import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // index.ts is a barrel and types.ts/schemas.ts are pure type/Zod
      // declarations with no executable branches — exclude from the
      // coverage gate. Everything else must hit 100% per CLAUDE.md
      // non-negotiables for the payment package.
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
