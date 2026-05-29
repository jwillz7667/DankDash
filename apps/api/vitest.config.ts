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
      // A user-provided `exclude` REPLACES Vitest's defaults (object spread,
      // not a merge), so the default `*.test.ts` exclusion is lost — re-add it
      // explicitly or the suite's own test files get measured as source.
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts', // Bootstrap path is exercised by integration tests via buildTestApp.
        'src/**/*.module.ts',
      ],
      thresholds: {
        // Payments is an existential gate alongside @dankdash/compliance —
        // CLAUDE.md mandates 100% LINE coverage, enforced here and verified by
        // the co-located unit suite. Branches are intentionally NOT pinned to
        // 100: a couple of defensive `?? null` guards on provider payloads are
        // unreachable in practice and not worth contorting fixtures to hit.
        'src/modules/payments/**/*.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
        },
        // NOTE: the repo-wide API floor (CLAUDE.md: "other services target
        // 80%") is deliberately NOT a hard threshold yet. The full API number
        // can only be produced by the integration suite (Docker/testcontainers),
        // so it has no locally-measured baseline; pinning 80% blind would risk
        // false-failing CI on an unmeasured gap. Coverage is still REPORTED to
        // Codecov on every run — once CI establishes the baseline, ratchet a
        // global floor in here at or just below it and tighten over time.
      },
    },
  },
});
