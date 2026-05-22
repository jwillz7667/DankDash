import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // The barrel file carries no behaviour to cover; everything else is
      // pure scoring + the per-order attempt orchestrator, both of which
      // are the contract that decides who delivers — must hit 100% lines
      // and branches. Test files themselves are excluded so the
      // `throw new Error('typenarrow')` branches don't drag coverage
      // down (those branches exist only to satisfy TypeScript's
      // discriminated-union narrowing in the test bodies).
      exclude: ['src/index.ts', 'src/**/*.test.ts'],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
