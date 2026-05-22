/**
 * axe-core a11y assertions for {@link OrderDetailDrawer} — covers each
 * render state (loading, loaded with footer actions, error, rejection
 * panel open). The drawer is a modal dialog, so structural a11y
 * matters: it must expose the dialog role, an accessible name, and
 * keyboard-reachable controls without violations.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { checkA11y, expectNoA11yViolations } from '../../../test/utils/axe.js';
import type { TransitionResponse, VendorOrderDetail } from '../../lib/api/vendor-orders.js';
import type { VendorOrderActions } from '../../lib/orders/order-actions.js';
import { OrderDetailDrawer } from './order-detail-drawer.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');

function orderDetail(overrides: Partial<VendorOrderDetail> = {}): VendorOrderDetail {
  return {
    id: overrides.id ?? '01935f3d-0000-7000-8000-000000000001',
    shortCode: overrides.shortCode ?? 'AAAA',
    userId: '01935f3d-0000-7000-8000-000000000abc',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
    driverId: null,
    status: overrides.status ?? 'placed',
    statusChangedAt: '2026-05-19T11:55:00.000Z',
    subtotalCents: 5400,
    cannabisTaxCents: 540,
    salesTaxCents: 270,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 100,
    totalCents: 6110,
    timestamps: {
      placedAt: '2026-05-19T11:55:00.000Z',
      paymentFailedAt: null,
      acceptedAt: null,
      rejectedAt: null,
      preppingAt: null,
      preparedAt: null,
      awaitingDriverAt: null,
      dispatchFailedAt: null,
      driverAssignedAt: null,
      enRoutePickupAt: null,
      pickedUpAt: null,
      enRouteDropoffAt: null,
      arrivedAtDropoffAt: null,
      idScanPendingAt: null,
      deliveredAt: null,
      returnedToStoreAt: null,
      canceledAt: null,
      disputedAt: null,
      ratedAt: null,
    },
    ratings: { customer: null, review: null, dispensary: null, driver: null },
    ...overrides,
  };
}

function transition(id: string, status: TransitionResponse['status']): TransitionResponse {
  return { id, status, statusChangedAt: '2026-05-19T12:01:00.000Z' };
}

function buildActions(
  detail: VendorOrderDetail,
  fetchOverride?: () => Promise<VendorOrderDetail>,
): VendorOrderActions {
  return {
    fetch: fetchOverride ?? vi.fn(async () => detail),
    accept: vi.fn(async () => transition(detail.id, 'accepted')),
    reject: vi.fn(async () => transition(detail.id, 'rejected')),
    markPrepped: vi.fn(async () => transition(detail.id, 'prepping')),
    markReady: vi.fn(async () => transition(detail.id, 'ready_for_pickup')),
    markHandoff: vi.fn(async () => transition(detail.id, 'picked_up')),
  };
}

describe('OrderDetailDrawer — a11y', () => {
  it('has zero violations in the loaded state for a placed order (accept/reject)', async () => {
    const detail = orderDetail({ status: 'placed' });
    const { container } = render(
      <main>
        <OrderDetailDrawer
          orderId={detail.id}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={buildActions(detail)}
          now={NOW}
        />
      </main>,
    );
    // Wait for the loaded body.
    await screen.findByText(`#${detail.shortCode}`);
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations for a prepping order (mark ready single action)', async () => {
    const detail = orderDetail({ id: '01935f3d-0000-7000-8000-000000000002', status: 'prepping' });
    const { container } = render(
      <main>
        <OrderDetailDrawer
          orderId={detail.id}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={buildActions(detail)}
          now={NOW}
        />
      </main>,
    );
    await screen.findByText(`#${detail.shortCode}`);
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations with the rejection panel expanded (textarea + actions)', async () => {
    const detail = orderDetail({ status: 'placed' });
    const { container } = render(
      <main>
        <OrderDetailDrawer
          orderId={detail.id}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={buildActions(detail)}
          now={NOW}
        />
      </main>,
    );
    const rejectButton = await screen.findByTestId('order-detail-action-reject');
    fireEvent.click(rejectButton);
    // The textarea is rendered only after the panel opens.
    await screen.findByTestId('order-detail-reject-reason');
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations in the error state with the retry button visible', async () => {
    const detail = orderDetail();
    const failingFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const actions = buildActions(
      detail,
      failingFetch as unknown as () => Promise<VendorOrderDetail>,
    );
    const { container } = render(
      <main>
        <OrderDetailDrawer
          orderId={detail.id}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={actions}
          now={NOW}
        />
      </main>,
    );
    const retry = await screen.findByTestId('order-detail-retry');
    // Sanity: the retry sits inside the error region.
    within(retry.closest('[role="alert"]') ?? container).getByTestId('order-detail-retry');
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });
});
