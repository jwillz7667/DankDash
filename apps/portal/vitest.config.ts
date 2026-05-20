import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the portal.
 *
 * - `jsdom` environment for React component tests.
 * - `@vitejs/plugin-react` provides JSX/TSX transform without a separate
 *   tsconfig path (Vitest uses esbuild internally, which is happy with the
 *   plugin's setup).
 * - `setupFiles` extend `expect` with `@testing-library/jest-dom` matchers.
 * - Coverage targets ≥70% per Phase 13 DoD (UI surface — lower bar than
 *   `domain/` packages).
 * - The `.test.ts(x)` glob lives next to source files; Playwright e2e
 *   specs live under `test/e2e/` and are excluded here (Playwright has its
 *   own runner via `pnpm test:e2e`).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}', 'test/unit/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**', '.next/**'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/types.ts',
        'src/app/**/layout.tsx',
        'src/app/**/page.tsx',
        'src/app/**/loading.tsx',
        'src/app/**/error.tsx',
        'src/app/**/not-found.tsx',
        'src/app/**/route.ts',
        'src/middleware.ts',
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
