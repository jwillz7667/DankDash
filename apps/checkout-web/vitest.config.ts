import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for checkout-web.
 *
 * - `jsdom` for the one client component (the review form).
 * - Coverage targets the pure lib/ logic (money + compliance formatting,
 *   request building, session-cookie helpers). The RSC pages, the layout,
 *   and the server action are integration-shaped (they reach the network /
 *   Next request scope) and are excluded from the unit-coverage gate —
 *   they are exercised by typecheck + `next build`, not vitest.
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
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/lib/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/lib/types.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
