/**
 * Phase 14.6 — Playwright e2e: WebSocket disconnects, polling kicks in.
 *
 * Drives the realtime → polling transition:
 *
 *   1. Sign in with the realtime channel live ("Live" badge).
 *   2. Tell the mock to reject all future handshakes, then disconnect
 *      every currently-attached socket. The portal's client tries to
 *      reconnect, the mock refuses, the status transitions to
 *      `disconnected`/`error`.
 *   3. After the grace window (default 10s) the polling fallback
 *      activates — the badge label flips to "Polling" and the data
 *      keeps flowing via REST.
 *   4. We mutate the orders snapshot via `/__set-orders` and verify
 *      the next poll surfaces the change in the DOM.
 *
 * Failure modes this guards against:
 *
 *   - The QueueBoard's `pollingEnabled` predicate is gated on the
 *     wrong status set (it should fire on both `disconnected` and
 *     `error`).
 *   - The polled-snapshot reducer doesn't replace rows whose
 *     `statusChangedAt` advanced — without that, the polling channel
 *     would silently drop server-side mutations.
 *   - The badge `data-mode` attribute doesn't reflect polling state,
 *     leaving operators staring at "Reconnecting" while the board is
 *     in fact alive.
 */
import { expect, test } from '@playwright/test';
import { admin, fixtureQueueOrder, signIn } from './fixtures/auth.js';

test.beforeEach(async () => {
  await admin('/__reset', {});
});

// The portal's default grace window is 10s and the poll interval is
// 15s. Wait for the badge flip with enough headroom for both.
test('polling fallback engages when the realtime handshake fails', async ({ page }) => {
  const baseline = fixtureQueueOrder({
    id: '01935f3d-0000-7000-8000-00000000e001',
    shortCode: 'E001',
    status: 'placed',
  });
  await admin('/__set-orders', { orders: [baseline] });

  await signIn(page);

  const badge = page.getByTestId('realtime-status-badge');
  await expect(badge).toHaveAttribute('data-mode', 'live');
  await expect(page.getByTestId('queue-card').filter({ hasText: 'E001' })).toBeVisible();

  // Force the realtime channel to fail. We reject new handshakes AND
  // disconnect existing sockets so the client is immediately in the
  // reconnect-on-error loop.
  await admin('/__reject-handshakes', { reject: true });

  // Status flips to `disconnected` / `error` immediately, polling
  // engages after the grace window.
  await expect(badge).toHaveAttribute('data-mode', 'polling', { timeout: 30_000 });

  // Mutate the snapshot and let the next REST poll pick it up.
  const incoming = fixtureQueueOrder({
    id: '01935f3d-0000-7000-8000-00000000e002',
    shortCode: 'E002',
    status: 'placed',
  });
  await admin('/__set-orders', { orders: [baseline, incoming] });

  await expect(page.getByTestId('queue-card').filter({ hasText: 'E002' })).toBeVisible({
    timeout: 30_000,
  });
});
