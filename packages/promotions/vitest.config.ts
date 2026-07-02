import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // index.ts is a barrel and types.ts is type-only — no runtime behaviour
      // to cover. The rest is pure money math that decides who pays for a
      // discount; it is held to the same 100% bar as pricing/compliance per
      // CLAUDE.md.
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
