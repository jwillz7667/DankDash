/**
 * Playwright config for the portal.
 *
 * The e2e suite runs against an *in-process mock stack* — not the real
 * NestJS API or Socket.io service. `test/e2e/fixtures/mock-stack.mjs`
 * stands in for both: the portal's server-side fetches see a Node HTTP
 * server returning canned vendor-orders responses, and the realtime
 * client connects to a real `socket.io` server on `/vendor` that emits
 * events on command from an admin HTTP surface the specs drive directly.
 *
 * Why mock and not the real backend?
 *
 *   - Next.js 15 server components run server-side fetches inside the
 *     portal process — `page.route()` (browser-side) cannot intercept
 *     them. The only way to control the orders the page renders is to
 *     stand up a real HTTP endpoint the portal points at, which is what
 *     `mock-stack.mjs` does.
 *   - The realtime client speaks the Socket.io protocol; mocking it
 *     with a fake WS framing would diverge from production. A real
 *     `socket.io` server adds <100ms to startup and exercises the
 *     handshake + namespace + reconnect paths the way prod uses them.
 *   - We get one source of truth for "what scenario is the queue in?"
 *     via admin POSTs (`/__set-orders`, `/__emit-created`,
 *     `/__reject-handshakes`) rather than scattering fetch stubs across
 *     specs.
 *
 * `webServer` boots both the mock stack and the Next dev server before
 * any spec runs. The dev server is started with env vars pointing at the
 * mock so every request the portal makes hits the in-process surface.
 *
 * `pnpm test:e2e` is intentionally NOT part of `pnpm test` — the unit
 * suite (Vitest) runs in the green-light command; e2e runs in a
 * dedicated CI job once the mock stack is up.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['PORTAL_PORT'] ?? 3010);
const MOCK_API_PORT = Number(process.env['MOCK_API_PORT'] ?? 4001);
const MOCK_REALTIME_PORT = Number(process.env['MOCK_REALTIME_PORT'] ?? 4002);
const MOCK_ADMIN_PORT = Number(process.env['MOCK_ADMIN_PORT'] ?? 4003);

// 32-byte deterministic secret — Auth.js requires ≥32 chars for the JWT
// session encryption key. Test-only; never used outside Playwright.
const E2E_AUTH_SECRET = 'e2e-playwright-secret-32-bytes-minimum-aaaaaa';

// Playwright's `webServer.env` REPLACES the spawned process's env (it
// does not merge with the parent's process.env). If we passed only the
// keys we care about, the child loses PATH / HOME / SHELL / pnpm's
// state and `next dev` can't resolve its own binary. Spread parent env
// first, then override the keys we want test-stack values for.
//
// Critically, we also unset NEXT_PUBLIC_* and INTERNAL_API_BASE_URL
// before our overrides land so a stray value in the user's shell can't
// outvote us. Next.js will not override process.env from .env.local
// when the var is already set, so once we set it here the dotenv file
// is a no-op for those keys.
const parentEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => typeof v === 'string') as [string, string][],
);

const mockEnv: Record<string, string> = {
  ...parentEnv,
  MOCK_API_PORT: String(MOCK_API_PORT),
  MOCK_REALTIME_PORT: String(MOCK_REALTIME_PORT),
  MOCK_ADMIN_PORT: String(MOCK_ADMIN_PORT),
};

// Use `localhost` (not `127.0.0.1`) for every URL the browser, the Auth.js
// runtime, and the Next.js server share. next-auth's client bundles bake
// `NEXTAUTH_URL` into the `signIn()` fetch target — when the page URL and
// that bundled URL disagree on host, cookies split across two domains
// and the post-sign-in session lookup returns null. Keep everything on
// the same hostname end-to-end.
const portalEnv: Record<string, string> = {
  ...parentEnv,
  PORT: String(PORT),
  NEXT_PUBLIC_API_BASE_URL: `http://localhost:${String(MOCK_API_PORT)}`,
  NEXT_PUBLIC_REALTIME_URL: `http://localhost:${String(MOCK_REALTIME_PORT)}`,
  INTERNAL_API_BASE_URL: `http://localhost:${String(MOCK_API_PORT)}`,
  AUTH_SECRET: E2E_AUTH_SECRET,
  NEXTAUTH_URL: `http://localhost:${String(PORT)}`,
  AUTH_URL: `http://localhost:${String(PORT)}`,
  NODE_ENV: 'development',
};

export default defineConfig({
  testDir: './test/e2e',
  // Specs share the mock stack's admin surface (POST /__reset, etc.)
  // and the realtime broadcast channel. Running them in parallel would
  // produce races where one spec's __set-orders clobbers another's
  // mid-render. Force serial — the suite is small (3 specs) so wall
  // time is not the concern.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Polling-fallback spec deliberately waits ~12s for the grace window
  // before asserting on the badge flip. Default 30s per-test is fine
  // for that; bump the suite-wide expect timeout so wait-for assertions
  // ride out the same window.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  webServer: [
    {
      command: `node test/e2e/fixtures/mock-stack.mjs`,
      url: `http://localhost:${String(MOCK_ADMIN_PORT)}/__health`,
      reuseExistingServer: !process.env['CI'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
      env: mockEnv,
    },
    {
      // Bind to `localhost` (0.0.0.0 would work too, but staying explicit
      // matches the env vars above). Auth.js's bundled NEXTAUTH_URL host
      // must equal the page URL host or the credentials POST writes
      // cookies on a different domain than the page can read.
      command: `pnpm exec next dev --hostname localhost --port ${String(PORT)}`,
      url: `http://localhost:${String(PORT)}/login`,
      reuseExistingServer: !process.env['CI'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      env: portalEnv,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
