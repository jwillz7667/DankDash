/**
 * Phase 14.6 — Playwright e2e: receive new order via realtime.
 *
 * Signs into the portal, opens the queue board with an empty initial
 * snapshot, then asks the mock realtime server to emit an `order:created`
 * event. The card must appear in the New column, sourced entirely from
 * the WS payload (no fetch round-trip).
 *
 * Failure modes this guards against:
 *
 *   - The realtime client doesn't subscribe to `order:created`.
 *   - The board's reducer ignores realtime-only inserts (e.g. requires
 *     the order to exist in the queue projection first).
 *   - The Socket.io handshake fails silently — the badge would say
 *     "Reconnecting" / "Offline" and no card would land.
 */
import { expect, test } from '@playwright/test';
import { admin, fixtureCreatedEvent, signIn } from './fixtures/auth.js';

test.beforeEach(async () => {
  await admin('/__reset', {});
});

test('renders a card pushed via order:created realtime event', async ({ page }) => {
  await admin('/__set-orders', { orders: [] });

  await signIn(page);

  // Wait for the queue board to be live before emitting — emitting
  // before the socket has joined produces a silent drop.
  const badge = page.getByTestId('realtime-status-badge');
  await expect(badge).toHaveAttribute('data-mode', 'live');

  const incoming = fixtureCreatedEvent({
    orderId: '01935f3d-0000-7000-8000-00000000c001',
    shortCode: 'C001',
    totalCents: 7400,
  });
  await admin('/__emit-created', incoming);

  const card = page.getByTestId('queue-card').filter({ hasText: 'C001' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-order-id', incoming.orderId);
});
