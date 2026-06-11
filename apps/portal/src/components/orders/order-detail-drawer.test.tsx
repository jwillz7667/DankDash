import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OrderStatus,
  TransitionResponse,
  VendorOrderDetail,
} from '../../lib/api/vendor-orders.js';
import type { VendorOrderActions } from '../../lib/orders/order-actions.js';
import { OrderDetailDrawer } from './order-detail-drawer.js';

const ORDER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-05-19T12:00:00.000Z');

function detail(overrides: Partial<VendorOrderDetail> = {}): VendorOrderDetail {
  return {
    id: ORDER_ID,
    shortCode: 'A1B2',
    userId: '01935f3d-0000-7000-8000-000000000abc',
    dispensaryId: DISPENSARY_ID,
    driverId: null,
    status: 'placed',
    statusChangedAt: '2026-05-19T11:55:00.000Z',
    subtotalCents: 5400,
    cannabisTaxCents: 540,
    salesTaxCents: 270,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 500,
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

function transitionResponse(status: OrderStatus): TransitionResponse {
  return { id: ORDER_ID, status, statusChangedAt: '2026-05-19T12:01:00.000Z' };
}

function buildActions(overrides: Partial<VendorOrderActions> = {}): VendorOrderActions {
  return {
    fetch: vi.fn(async () => detail()),
    accept: vi.fn(async () => transitionResponse('accepted')),
    reject: vi.fn(async () => transitionResponse('rejected')),
    markPrepped: vi.fn(async () => transitionResponse('prepping')),
    markReady: vi.fn(async () => transitionResponse('ready_for_pickup')),
    markHandoff: vi.fn(async () => transitionResponse('picked_up')),
    ...overrides,
  };
}

describe('OrderDetailDrawer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when orderId is null', () => {
    const actions = buildActions();
    render(
      <OrderDetailDrawer
        orderId={null}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={actions}
      />,
    );
    expect(screen.queryByTestId('order-detail-drawer')).toBeNull();
    expect(actions.fetch).not.toHaveBeenCalled();
  });

  it('fetches the order detail when an orderId is provided', async () => {
    const actions = buildActions();
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={actions}
        now={NOW}
      />,
    );

    expect(actions.fetch).toHaveBeenCalledWith(ORDER_ID);
    expect(await screen.findByText('#A1B2')).toBeInTheDocument();
    expect(screen.getByTestId('order-detail-status')).toHaveTextContent('Placed');
  });

  it('renders a spinner while the fetch is in flight', async () => {
    let resolveFetch: (value: VendorOrderDetail) => void = () => undefined;
    const actions = buildActions({
      fetch: vi.fn(
        () =>
          new Promise<VendorOrderDetail>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    });
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByText(/Loading order/u)).toBeInTheDocument();
    await act(async () => {
      resolveFetch(detail());
    });
    expect(await screen.findByText('#A1B2')).toBeInTheDocument();
  });

  it('renders an error state with retry when fetch rejects', async () => {
    const fetchMock = vi.fn<VendorOrderActions['fetch']>(async () => {
      throw new Error('boom');
    });
    const actions = buildActions({ fetch: fetchMock });
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={actions}
      />,
    );

    expect(await screen.findByText("Couldn't load the order")).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    // After retry, fetch is called again — this time succeeding.
    fetchMock.mockImplementationOnce(async () => detail());
    fireEvent.click(screen.getByTestId('order-detail-retry'));
    expect(await screen.findByText('#A1B2')).toBeInTheDocument();
  });

  it('fires onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={onClose}
        onTransition={vi.fn()}
        actions={buildActions()}
      />,
    );
    await screen.findByText('#A1B2');
    fireEvent.click(screen.getByTestId('order-detail-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={onClose}
        onTransition={vi.fn()}
        actions={buildActions()}
      />,
    );
    await screen.findByText('#A1B2');
    fireEvent.click(screen.getByTestId('order-detail-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when ESC is pressed', async () => {
    const onClose = vi.fn();
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={onClose}
        onTransition={vi.fn()}
        actions={buildActions()}
      />,
    );
    await screen.findByText('#A1B2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('paints only stamped timestamps in the timeline (skips nulls)', async () => {
    const actions = buildActions({
      fetch: vi.fn(async () =>
        detail({
          status: 'accepted',
          timestamps: {
            ...detail().timestamps,
            acceptedAt: '2026-05-19T11:58:00.000Z',
          },
        }),
      ),
    });
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={actions}
        now={NOW}
      />,
    );

    const timeline = (await screen.findByLabelText('Order timeline')).querySelector('ol')!;
    const items = within(timeline as HTMLElement).getAllByRole('listitem');
    // Two entries: Placed + Accepted; no Rejected/Prepping/etc.
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Placed');
    expect(items[1]).toHaveTextContent('Accepted');
  });

  it('shows a discount line only when discountCents > 0', async () => {
    const noDiscount = buildActions({
      fetch: vi.fn(async () => detail({ discountCents: 0 })),
    });
    const { unmount } = render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={noDiscount}
        now={NOW}
      />,
    );
    await screen.findByText('#A1B2');
    expect(screen.queryByText('Discount')).toBeNull();
    unmount();

    const withDiscount = buildActions();
    render(
      <OrderDetailDrawer
        orderId={ORDER_ID}
        onClose={vi.fn()}
        onTransition={vi.fn()}
        actions={withDiscount}
        now={NOW}
      />,
    );
    await screen.findByText('#A1B2');
    expect(screen.getByText('Discount')).toBeInTheDocument();
  });

  describe('status-driven action surface', () => {
    async function renderForStatus(status: OrderStatus): Promise<{ actions: VendorOrderActions }> {
      const actions = buildActions({
        fetch: vi.fn(async () => detail({ status })),
      });
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');
      return { actions };
    }

    it('placed → Accept + Reject buttons', async () => {
      await renderForStatus('placed');
      expect(screen.getByTestId('order-detail-action-accept')).toBeInTheDocument();
      expect(screen.getByTestId('order-detail-action-reject')).toBeInTheDocument();
      expect(screen.queryByTestId('order-detail-action-prepped')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-ready')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-handoff')).toBeNull();
    });

    it('accepted → Start Prepping + Reject', async () => {
      await renderForStatus('accepted');
      expect(screen.getByTestId('order-detail-action-prepped')).toBeInTheDocument();
      expect(screen.getByTestId('order-detail-action-reject')).toBeInTheDocument();
      expect(screen.queryByTestId('order-detail-action-accept')).toBeNull();
    });

    it('prepping → Mark Ready', async () => {
      await renderForStatus('prepping');
      expect(screen.getByTestId('order-detail-action-ready')).toBeInTheDocument();
      expect(screen.queryByTestId('order-detail-action-accept')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-reject')).toBeNull();
    });

    it('driver_assigned → no actions (handoff waits for the driver to arrive)', async () => {
      await renderForStatus('driver_assigned');
      expect(screen.queryByTestId('order-detail-action-handoff')).toBeNull();
    });

    it('en_route_pickup → Confirm Handoff', async () => {
      await renderForStatus('en_route_pickup');
      expect(screen.getByTestId('order-detail-action-handoff')).toBeInTheDocument();
    });

    it('ready_for_pickup → no actions (waiting on dispatch)', async () => {
      await renderForStatus('ready_for_pickup');
      expect(screen.queryByTestId('order-detail-action-accept')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-reject')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-prepped')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-ready')).toBeNull();
      expect(screen.queryByTestId('order-detail-action-handoff')).toBeNull();
    });
  });

  describe('transition wiring', () => {
    it('calls actions.accept and fires onTransition on success', async () => {
      const onTransition = vi.fn();
      const actions = buildActions();
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={onTransition}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      await act(async () => {
        fireEvent.click(screen.getByTestId('order-detail-action-accept'));
      });

      expect(actions.accept).toHaveBeenCalledWith(ORDER_ID);
      expect(onTransition).toHaveBeenCalledWith({
        id: ORDER_ID,
        status: 'accepted',
        statusChangedAt: '2026-05-19T12:01:00.000Z',
      });
      // Drawer reflects the new status optimistically — badge swaps.
      expect(screen.getByTestId('order-detail-status')).toHaveTextContent('Accepted');
    });

    it('calls actions.markPrepped on Start Prepping click', async () => {
      const onTransition = vi.fn();
      const actions = buildActions({
        fetch: vi.fn(async () => detail({ status: 'accepted' })),
      });
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={onTransition}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      await act(async () => {
        fireEvent.click(screen.getByTestId('order-detail-action-prepped'));
      });

      expect(actions.markPrepped).toHaveBeenCalledWith(ORDER_ID);
      expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ status: 'prepping' }));
    });

    it('calls actions.markHandoff on Confirm Handoff click', async () => {
      const actions = buildActions({
        fetch: vi.fn(async () => detail({ status: 'en_route_pickup' })),
      });
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      await act(async () => {
        fireEvent.click(screen.getByTestId('order-detail-action-handoff'));
      });

      expect(actions.markHandoff).toHaveBeenCalledWith(ORDER_ID);
    });

    it('surfaces an error message when the action rejects (and does not call onTransition)', async () => {
      const onTransition = vi.fn();
      const actions = buildActions({
        accept: vi.fn(async () => {
          throw new Error('Server said no');
        }),
      });
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={onTransition}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      await act(async () => {
        fireEvent.click(screen.getByTestId('order-detail-action-accept'));
      });

      expect(await screen.findByTestId('order-detail-action-error')).toHaveTextContent(
        'Server said no',
      );
      expect(onTransition).not.toHaveBeenCalled();
    });
  });

  describe('reject reason flow', () => {
    it('opens the reason textarea on Reject click and keeps submit disabled while empty', async () => {
      const actions = buildActions();
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      fireEvent.click(screen.getByTestId('order-detail-action-reject'));
      const submit = await screen.findByTestId('order-detail-reject-submit');
      expect(submit).toBeDisabled();
      expect(actions.reject).not.toHaveBeenCalled();
    });

    it('enables submit when reason has non-empty trimmed text, then calls actions.reject', async () => {
      const onTransition = vi.fn();
      const actions = buildActions();
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={onTransition}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      fireEvent.click(screen.getByTestId('order-detail-action-reject'));
      const textarea = await screen.findByTestId('order-detail-reject-reason');
      fireEvent.change(textarea, { target: { value: '   Out of stock   ' } });

      const submit = screen.getByTestId('order-detail-reject-submit');
      expect(submit).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(submit);
      });

      expect(actions.reject).toHaveBeenCalledWith(ORDER_ID, 'Out of stock');
      expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    });

    it('hides the reason input on Cancel and re-shows the Reject button', async () => {
      const actions = buildActions();
      render(
        <OrderDetailDrawer
          orderId={ORDER_ID}
          onClose={vi.fn()}
          onTransition={vi.fn()}
          actions={actions}
          now={NOW}
        />,
      );
      await screen.findByText('#A1B2');

      fireEvent.click(screen.getByTestId('order-detail-action-reject'));
      await screen.findByTestId('order-detail-reject-reason');

      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('order-detail-reject-reason')).toBeNull();
      });
      expect(screen.getByTestId('order-detail-action-reject')).toBeInTheDocument();
    });
  });

  it('refetches when the orderId prop changes (selecting a different card)', async () => {
    const detailA = detail({ id: 'a', shortCode: 'AAAA' });
    const detailB = detail({ id: 'b', shortCode: 'BBBB' });
    const fetchMock = vi.fn(async (id: string) => (id === 'a' ? detailA : detailB));
    const actions = buildActions({ fetch: fetchMock });

    const { rerender } = render(
      <OrderDetailDrawer orderId="a" onClose={vi.fn()} onTransition={vi.fn()} actions={actions} />,
    );
    expect(await screen.findByText('#AAAA')).toBeInTheDocument();

    rerender(
      <OrderDetailDrawer orderId="b" onClose={vi.fn()} onTransition={vi.fn()} actions={actions} />,
    );
    expect(await screen.findByText('#BBBB')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
