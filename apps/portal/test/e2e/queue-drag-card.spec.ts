/**
 * Phase 14.6 — Playwright e2e: drag a card New → Prepping.
 *
 * Pre-seeds a `placed` order, signs in, navigates to the queue, and
 * drags the card from the New column onto the Prepping column. The
 * forward-only drag-drop rules (see `lib/orders/queue-dnd.ts`) mean
 * this resolves to an `accept` action — we then verify the mock API
 * recorded a `POST /v1/vendor/orders/:id/accept` via the admin
 * surface's `/__transitions` log.
 *
 * Failure modes this guards against:
 *
 *   - The drag pointer-sensor activation distance prevents the drop
 *     from registering. The board sets `dragActivationDistance` to 6,
 *     so we use Playwright's drag steps to clear it.
 *   - The drop zone is bound to the wrong column key.
 *   - The drag handler awaits the server response and surfaces the
 *     error inline instead of moving the card.
 *   - The action server-action posts to the wrong URL.
 */
import { expect, test } from '@playwright/test';
import { admin, fixtureQueueOrder, signIn } from './fixtures/auth.js';

interface TransitionsResponse {
  readonly calls: readonly {
    readonly id: string;
    readonly key: string;
    readonly body: unknown;
    readonly at: string;
  }[];
}

test.beforeEach(async () => {
  await admin('/__reset', {});
});

test('dragging a placed card to Prepping fires POST .../accept', async ({ page }) => {
  const order = fixtureQueueOrder({
    id: '01935f3d-0000-7000-8000-00000000d001',
    shortCode: 'D001',
    status: 'placed',
  });
  await admin('/__set-orders', { orders: [order] });

  await signIn(page);

  // The card must be on the page and draggable before we touch it.
  const card = page.getByTestId('queue-card').filter({ hasText: 'D001' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-draggable', 'true');

  const dropZone = page.locator('[data-column-droppable="prepping"]');
  await expect(dropZone).toBeVisible();

  // Use bounding-box-driven mouse steps. Playwright's
  // `dragTo` resolves the activation distance correctly but the
  // PointerSensor's `distance` guard wants visible motion between
  // mousedown and mousemove — the manual flow does exactly that.
  const cardBox = await card.boundingBox();
  const targetBox = await dropZone.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (cardBox === null || targetBox === null) {
    throw new Error('drag boxes unresolved');
  }

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in a few steps so dnd-kit registers the pointer travel
  // exceeded the activation distance.
  await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();

  // The mock API records every POST .../accept|reject|... in
  // state.transitions. We poll for the accept call rather than
  // assert immediately — the drag handler is async.
  await expect
    .poll(
      async () => {
        const log = (await admin('/__transitions')) as TransitionsResponse;
        return log.calls.find((c) => c.id === order.id && c.key === 'accept') !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});
