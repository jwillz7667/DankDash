import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest's default esbuild transformer strips decorators but never emits
  // the `design:paramtypes` metadata that NestJS DI reads to resolve
  // constructor parameters. SWC with `decoratorMetadata: true` is the only
  // transformer in the ecosystem that emits the same metadata `tsc` does,
  // so feature integration tests can boot AppModule and get real services
  // injected. Targets `src/**` and `test/**` — same scope tsconfig.json sees.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Container boot + migrations take ~15s on cold runs; matches the budget
    // in packages/db/vitest.config.ts so CI does not flake on slow Docker pulls.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // globalSetup runs ONCE per `pnpm test`, boots a shared Postgres+PostGIS
    // testcontainer, and exports DATABASE_URL/TEST_DATABASE_URL. env-setup.ts
    // uses `??=` so the container URL takes priority over any defaults; tests
    // that build the NestJS app via buildTestApp() get the real DB for free.
    globalSetup: ['./test/global-setup.ts'],
    // Seeds process.env defaults so AppModule's ConfigModule validation
    // succeeds before any test-file import is evaluated.
    setupFiles: ['./test/helpers/env-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts', // Bootstrap path is exercised by integration tests via buildTestApp.
        'src/**/*.module.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
