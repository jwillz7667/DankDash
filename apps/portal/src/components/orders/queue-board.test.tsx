import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
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

describe('QueueBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
});
