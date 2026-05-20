/**
 * axe-core a11y assertions for the queue board surface — the Phase 14
 * DoD requires zero violations on the operator-critical screen.
 *
 * Coverage:
 *   - Empty queue (four empty columns)
 *   - Queue with mixed-status cards
 *   - Queue with the order detail drawer open (modal dialog + backdrop)
 *
 * Each scenario wraps the board in a `<main>` landmark so the
 * `region` rule isn't tripped by columns mounted outside any landmark
 * during isolated render — production wraps it in the dashboard
 * shell, so the rule's intent is already satisfied at the page level.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y, expectNoA11yViolations } from '../../../test/utils/axe.js';
import type {
  TransitionResponse,
  VendorOrderDetail,
  VendorQueueOrderSummary,
} from '../../lib/api/vendor-orders.js';
import type { VendorOrderActions } from '../../lib/orders/order-actions.js';
import { QueueBoard } from './queue-board.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');

function order(
  overrides: Partial<VendorQueueOrderSummary> & {
    readonly id: string;
    readonly status: VendorQueueOrderSummary['status'];
  },
): VendorQueueOrderSummary {
  return {
    shortCode: overrides.id.slice(0, 4).toUpperCase(),
    userId: '01935f3d-0000-7000-8000-000000000abc',
    customerName: 'Mia Reyes',
    itemCount: 2,
    subtotalCents: 5400,
    totalCents: 6210,
    placedAt: '2026-05-19T11:55:00.000Z',
    statusChangedAt: '2026-05-19T11:55:00.000Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

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
    discountCents: 0,
    totalCents: 6210,
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

function buildActions(detail: VendorOrderDetail): VendorOrderActions {
  return {
    fetch: vi.fn(async () => detail),
    accept: vi.fn(async () => transition(detail.id, 'accepted')),
    reject: vi.fn(async () => transition(detail.id, 'rejected')),
    markPrepped: vi.fn(async () => transition(detail.id, 'prepping')),
    markReady: vi.fn(async () => transition(detail.id, 'ready_for_pickup')),
    markHandoff: vi.fn(async () => transition(detail.id, 'picked_up')),
  };
}

describe('QueueBoard — a11y', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has zero violations with an empty queue', async () => {
    const { container } = render(
      <main>
        <QueueBoard initialOrders={[]} />
      </main>,
    );
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations with a populated queue across every column', async () => {
    const orders = [
      order({ id: 'a', status: 'placed', customerName: 'Aaron' }),
      order({ id: 'b', status: 'prepping', customerName: 'Beth' }),
      order({ id: 'c', status: 'ready_for_pickup', customerName: 'Cara' }),
      order({ id: 'd', status: 'driver_assigned', customerName: 'Dee' }),
    ];
    const { container } = render(
      <main>
        <QueueBoard initialOrders={orders} actions={buildActions(orderDetail())} />
      </main>,
    );
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations with the order detail drawer open', async () => {
    const detail = orderDetail({ id: 'a', shortCode: 'AAAA', status: 'placed' });
    const { container } = render(
      <main>
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
          actions={buildActions(detail)}
        />
      </main>,
    );

    fireEvent.click(screen.getByText('Aaron'));
    // Wait for the drawer to paint the loaded detail body.
    expect(await screen.findByText('#AAAA')).toBeInTheDocument();

    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });
});
