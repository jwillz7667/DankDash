import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TransitionResponse,
  VendorOrderDetail,
  VendorQueueOrderSummary,
} from '../../lib/api/vendor-orders.js';
import type { VendorOrderActions } from '../../lib/orders/order-actions.js';
import {
  RealtimeClient,
  type OrderStatusChange,
  type OrderSummary,
  type RealtimeEventHandler,
  type RealtimeEventName,
  type StatusListener,
  type RealtimeStatus,
} from '../../lib/realtime/client.js';
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
    itemCount: 1,
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

/**
 * Mirrors the hook-level FakeClient (lib/realtime/hooks.test.tsx) —
 * bypasses socket.io entirely, exposes `emit*` methods so the test
 * drives the realtime path deterministically.
 */
class FakeClient extends RealtimeClient {
  public connectCalls = 0;
  public disconnectCalls = 0;
  private statusListener: StatusListener | null = null;
  private orderCreatedHandler: RealtimeEventHandler<'order:created'> | null = null;
  private orderStatusHandler: RealtimeEventHandler<'order:status_changed'> | null = null;

  constructor() {
    super({ url: 'wss://test', token: 't' });
  }

  override connect(): void {
    this.connectCalls += 1;
  }
  override disconnect(): void {
    this.disconnectCalls += 1;
  }
  override onStatusChange(listener: StatusListener): () => void {
    this.statusListener = listener;
    listener('connecting');
    return () => {
      this.statusListener = null;
    };
  }
  override on<E extends RealtimeEventName>(event: E, handler: RealtimeEventHandler<E>): () => void {
    if (event === 'order:created') {
      this.orderCreatedHandler = handler as RealtimeEventHandler<'order:created'>;
      return () => {
        this.orderCreatedHandler = null;
      };
    }
    this.orderStatusHandler = handler as RealtimeEventHandler<'order:status_changed'>;
    return () => {
      this.orderStatusHandler = null;
    };
  }

  emitStatus(s: RealtimeStatus): void {
    this.statusListener?.(s);
  }
  emitCreated(p: OrderSummary): void {
    this.orderCreatedHandler?.(p);
  }
  emitStatusChange(p: OrderStatusChange): void {
    this.orderStatusHandler?.(p);
  }
}

const REALTIME = { url: 'wss://test', token: 'jwt-1' } as const;

function orderDetail(overrides: Partial<VendorOrderDetail> = {}): VendorOrderDetail {
  return {
    id: overrides.id ?? '01935f3d-0000-7000-8000-000000000001',
    shortCode: overrides.shortCode ?? 'A1B2',
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

function buildActions(overrides: Partial<VendorOrderActions> = {}): VendorOrderActions {
  return {
    fetch: vi.fn(async () => orderDetail()),
    accept: vi.fn(async () => transition('a', 'accepted')),
    reject: vi.fn(async () => transition('a', 'rejected')),
    markPrepped: vi.fn(async () => transition('a', 'prepping')),
    markReady: vi.fn(async () => transition('a', 'ready_for_pickup')),
    markHandoff: vi.fn(async () => transition('a', 'picked_up')),
    ...overrides,
  };
}

describe('QueueBoard', () => {
  beforeEach(() => {
    // `shouldAdvanceTime: true` lets `findBy*` polling (which uses
    // setTimeout) progress while keeping `vi.setSystemTime` + the
    // explicit `vi.advanceTimersByTime` calls below deterministic for
    // the tick test.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all four columns even when the board is empty', () => {
    render(<QueueBoard initialOrders={[]} />);
    expect(screen.getByRole('region', { name: 'Order queue' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /New column/u })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Prepping column/u })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Ready column/u })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Out for Delivery column/u })).toBeInTheDocument();
  });

  it('buckets each order into its corresponding column', () => {
    const orders = [
      order({ id: 'a', status: 'placed', customerName: 'Aaron' }),
      order({ id: 'b', status: 'accepted', customerName: 'Beth' }),
      order({ id: 'c', status: 'ready_for_pickup', customerName: 'Cara' }),
      order({ id: 'd', status: 'driver_assigned', customerName: 'Dee' }),
    ];
    const { container } = render(<QueueBoard initialOrders={orders} />);

    const cols: Record<string, HTMLElement> = {};
    for (const key of ['new', 'prepping', 'ready', 'out_for_delivery']) {
      const found = container.querySelector(`[data-column-key="${key}"]`);
      expect(found).not.toBeNull();
      cols[key] = found as HTMLElement;
    }

    expect(within(cols['new']!).getByText('Aaron')).toBeInTheDocument();
    expect(within(cols['prepping']!).getByText('Beth')).toBeInTheDocument();
    expect(within(cols['ready']!).getByText('Cara')).toBeInTheDocument();
    expect(within(cols['out_for_delivery']!).getByText('Dee')).toBeInTheDocument();
  });

  it('ignores orders whose status falls outside any column (delivered, canceled)', () => {
    const orders = [
      order({ id: 'live', status: 'placed', customerName: 'Live One' }),
      order({ id: 'gone', status: 'delivered', customerName: 'Gone One' }),
    ];
    render(<QueueBoard initialOrders={orders} />);
    expect(screen.getByText('Live One')).toBeInTheDocument();
    expect(screen.queryByText('Gone One')).not.toBeInTheDocument();
  });

  it('reads the same "now" across every card so ages stay consistent within a paint', () => {
    const orders = [
      order({ id: 'a', status: 'placed', statusChangedAt: '2026-05-19T11:55:00.000Z' }),
      order({ id: 'b', status: 'prepping', statusChangedAt: '2026-05-19T11:55:00.000Z' }),
    ];
    render(<QueueBoard initialOrders={orders} />);
    const ages = screen.getAllByText('5m ago');
    expect(ages).toHaveLength(2);
  });

  it('ticks the relative clock on the configured interval', () => {
    const factory = (): Date => new Date(NOW.getTime() + (factory.calls += 1) * 60_000);
    factory.calls = -1;

    const orders = [order({ id: 'a', status: 'placed', statusChangedAt: NOW.toISOString() })];
    render(<QueueBoard initialOrders={orders} nowFactory={factory} tickIntervalMs={60_000} />);

    expect(screen.getByText('just now')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // After one tick, factory returns NOW + 60s; the card reads "1m ago".
    expect(screen.getByText('1m ago')).toBeInTheDocument();
  });

  describe('realtime status badge', () => {
    it('paints "Offline" when no realtime config is supplied', () => {
      render(<QueueBoard initialOrders={[]} />);
      const badge = screen.getByTestId('realtime-status-badge');
      expect(badge).toHaveTextContent('Offline');
      expect(badge.dataset['status']).toBe('idle');
    });

    it('paints "Connecting" → "Live" as the socket progresses', () => {
      const fake = new FakeClient();
      render(
        <QueueBoard
          initialOrders={[]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      // onStatusChange fires immediately with 'connecting' inside the hook.
      const badge = screen.getByTestId('realtime-status-badge');
      expect(badge).toHaveTextContent('Connecting');

      act(() => {
        fake.emitStatus('connected');
      });
      expect(badge).toHaveTextContent('Live');
      expect(badge.dataset['status']).toBe('connected');
    });

    it('paints "Reconnecting" on a disconnected status', () => {
      const fake = new FakeClient();
      render(
        <QueueBoard
          initialOrders={[]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      act(() => {
        fake.emitStatus('disconnected');
      });
      const badge = screen.getByTestId('realtime-status-badge');
      expect(badge).toHaveTextContent('Reconnecting');
    });
  });

  describe('drawer integration', () => {
    it('cards are not interactive when actions are not supplied', () => {
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
        />,
      );
      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.tagName).toBe('ARTICLE');
      expect(screen.queryByTestId('order-detail-drawer')).toBeNull();
    });

    it('clicking a card opens the drawer; the close button hides it', async () => {
      const actions = buildActions({
        fetch: vi.fn(async () => orderDetail({ id: 'a', shortCode: 'AAAA' })),
      });
      render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
          actions={actions}
        />,
      );

      expect(screen.queryByTestId('order-detail-drawer')).toBeNull();
      fireEvent.click(screen.getByText('Aaron'));
      expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();
      expect(await screen.findByText('#AAAA')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('order-detail-close'));
      expect(screen.queryByTestId('order-detail-drawer')).toBeNull();
    });
  });

  describe('realtime patching', () => {
    it('inserts a new card on order:created in the matching column', () => {
      const fake = new FakeClient();
      const { container } = render(
        <QueueBoard
          initialOrders={[]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      act(() => {
        fake.emitCreated({
          orderId: 'new-1',
          customerId: '01935f3d-0000-7000-8000-000000000abc',
          dispensaryId: '01935f3d-0000-7000-8000-000000000def',
          shortCode: 'AB12',
          totalCents: 7800,
          status: 'placed',
          placedAt: NOW.toISOString(),
        });
      });

      const newCol = container.querySelector('[data-column-key="new"]')!;
      const cards = newCol.querySelectorAll('[data-testid="queue-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]?.getAttribute('data-order-id')).toBe('new-1');
      // Realtime payload doesn't carry customerName, so the placeholder renders.
      expect(within(newCol as HTMLElement).getByText('Guest customer')).toBeInTheDocument();
      expect(within(newCol as HTMLElement).getByText('#AB12')).toBeInTheDocument();
    });

    it('is idempotent on a redelivered order:created event', () => {
      const fake = new FakeClient();
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'seed', status: 'placed' })]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      const payload: OrderSummary = {
        orderId: 'seed',
        customerId: '01935f3d-0000-7000-8000-000000000abc',
        dispensaryId: '01935f3d-0000-7000-8000-000000000def',
        shortCode: 'SEED',
        totalCents: 1000,
        status: 'placed',
        placedAt: NOW.toISOString(),
      };
      act(() => {
        fake.emitCreated(payload);
        fake.emitCreated(payload);
      });

      const newCol = container.querySelector('[data-column-key="new"]')!;
      const cards = newCol.querySelectorAll('[data-testid="queue-card"]');
      expect(cards).toHaveLength(1);
    });

    it('moves a card to the new column on order:status_changed', () => {
      const fake = new FakeClient();
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      // Initial paint: Aaron is in the New column.
      expect(
        within(container.querySelector<HTMLElement>('[data-column-key="new"]')!).getByText('Aaron'),
      ).toBeInTheDocument();

      act(() => {
        fake.emitStatusChange({
          orderId: 'a',
          customerId: '01935f3d-0000-7000-8000-000000000abc',
          dispensaryId: '01935f3d-0000-7000-8000-000000000def',
          driverId: null,
          fromStatus: 'placed',
          toStatus: 'accepted',
          changedAt: '2026-05-19T12:01:00.000Z',
        });
      });

      // After the event: Aaron moved to the Prepping column.
      expect(
        within(container.querySelector<HTMLElement>('[data-column-key="new"]')!).queryByText(
          'Aaron',
        ),
      ).toBeNull();
      expect(
        within(container.querySelector<HTMLElement>('[data-column-key="prepping"]')!).getByText(
          'Aaron',
        ),
      ).toBeInTheDocument();
    });

    it('drops the card on a transition off the queue surface (delivered, canceled)', () => {
      const fake = new FakeClient();
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'driver_assigned', customerName: 'Aaron' })]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );
      expect(screen.getByText('Aaron')).toBeInTheDocument();

      act(() => {
        fake.emitStatusChange({
          orderId: 'a',
          customerId: '01935f3d-0000-7000-8000-000000000abc',
          dispensaryId: '01935f3d-0000-7000-8000-000000000def',
          driverId: null,
          fromStatus: 'driver_assigned',
          toStatus: 'delivered',
          changedAt: '2026-05-19T12:30:00.000Z',
        });
      });

      // The card vanishes entirely — bucketByColumn drops it.
      expect(screen.queryByText('Aaron')).toBeNull();
      const allCards = container.querySelectorAll('[data-testid="queue-card"]');
      expect(allCards).toHaveLength(0);
    });

    it('folds a transition response onto the snapshot via the same status-change reducer', async () => {
      const fake = new FakeClient();
      const actions = buildActions({
        fetch: vi.fn(async () => orderDetail({ id: 'a', status: 'placed' })),
        accept: vi.fn(async () => transition('a', 'accepted')),
      });
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
          realtime={REALTIME}
          actions={actions}
          clientFactory={(): FakeClient => fake}
        />,
      );

      // Open the drawer by clicking the card.
      fireEvent.click(screen.getByText('Aaron'));
      // Wait for the drawer to load.
      expect(await screen.findByTestId('order-detail-drawer')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('order-detail-action-accept'));
      });

      expect(actions.accept).toHaveBeenCalledWith('a');
      // Card moved into the Prepping column (accepted is bucketed there).
      expect(
        within(container.querySelector<HTMLElement>('[data-column-key="prepping"]')!).getByText(
          'Aaron',
        ),
      ).toBeInTheDocument();
      expect(
        within(container.querySelector<HTMLElement>('[data-column-key="new"]')!).queryByText(
          'Aaron',
        ),
      ).toBeNull();
    });

    it('ignores status changes for unknown order ids (stale tab safety)', () => {
      const fake = new FakeClient();
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
          realtime={REALTIME}
          clientFactory={(): FakeClient => fake}
        />,
      );

      act(() => {
        fake.emitStatusChange({
          orderId: 'never-seen',
          customerId: '01935f3d-0000-7000-8000-000000000abc',
          dispensaryId: '01935f3d-0000-7000-8000-000000000def',
          driverId: null,
          fromStatus: 'placed',
          toStatus: 'accepted',
          changedAt: '2026-05-19T12:01:00.000Z',
        });
      });

      const cards = container.querySelectorAll('[data-testid="queue-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]?.getAttribute('data-order-id')).toBe('a');
    });
  });

  describe('drag-drop integration', () => {
    it('marks placed and prepping cards as draggable when actions are wired', () => {
      const { container } = render(
        <QueueBoard
          initialOrders={[
            order({ id: 'a', status: 'placed', customerName: 'Aaron' }),
            order({ id: 'b', status: 'prepping', customerName: 'Beth' }),
            order({ id: 'c', status: 'ready_for_pickup', customerName: 'Cara' }),
            order({ id: 'd', status: 'awaiting_driver', customerName: 'Dee' }),
            order({ id: 'e', status: 'accepted', customerName: 'Ed' }),
          ]}
          actions={buildActions()}
        />,
      );

      const card = (id: string): Element | null =>
        container.querySelector(`[data-order-id="${id}"]`);

      expect(card('a')?.getAttribute('data-draggable')).toBe('true');
      expect(card('b')?.getAttribute('data-draggable')).toBe('true');
      // accepted is in the Prepping column but cannot drag directly to
      // Ready — operator must mark it prepping first via the drawer.
      expect(card('e')?.getAttribute('data-draggable')).toBe('false');
      expect(card('c')?.getAttribute('data-draggable')).toBe('false');
      expect(card('d')?.getAttribute('data-draggable')).toBe('false');
    });

    it('leaves cards non-draggable when actions are not supplied', () => {
      const { container } = render(
        <QueueBoard
          initialOrders={[order({ id: 'a', status: 'placed', customerName: 'Aaron' })]}
        />,
      );
      // No actions → no drag, no select. data-draggable attribute only
      // exists on the interactive (button) branch; article cards omit
      // it entirely.
      const card = container.querySelector('[data-order-id="a"]');
      expect(card?.tagName).toBe('ARTICLE');
      expect(card?.getAttribute('data-draggable')).toBeNull();
    });

    it('marks every column droppable when actions are wired', () => {
      const { container } = render(<QueueBoard initialOrders={[]} actions={buildActions()} />);
      const droppables = container.querySelectorAll('[data-column-droppable]');
      expect(droppables).toHaveLength(4);
    });
  });
});
