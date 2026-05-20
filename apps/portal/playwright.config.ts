/**
 * Playwright config for the portal.
 *
 * E2E specs live in `test/e2e/`. The dev server isn't auto-started here —
 * CI brings up the API + portal in the workflow file, and locally you run
 * `pnpm --filter @dankdash/portal dev` in another tab. This keeps the
 * config simple and avoids Playwright fighting with Next's dev server
 * over the port when the suite is invoked mid-development.
 *
 * `pnpm test:e2e` is intentionally NOT part of `pnpm test` — the unit
 * suite (Vitest) runs in the green-light command; e2e runs in a dedicated
 * CI job once a real environment is up.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['PORTAL_PORT'] ?? 3001);

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
