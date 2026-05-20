import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // Barrels, pure type modules, and the typed Recipient/NotificationSpec
      // contract have no executable branches worth gating on. Everything
      // with logic (templates, providers, dispatcher) must hit 100% — these
      // outputs become persistent records on the user (push payloads, SMS
      // bodies, transactional emails), so any uncovered branch is a latent
      // user-facing bug.
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/providers/index.ts',
        'src/providers/provider.ts',
        'src/templates/index.ts',
        'src/templates/template.ts',
        'src/**/*.test.ts',
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
