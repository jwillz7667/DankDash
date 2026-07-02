import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { RecentOrdersCard } from './recent-orders-card.js';

const NOW = new Date('2026-07-02T15:30:00.000Z');

function makeOrder(overrides: Partial<VendorQueueOrderSummary> = {}): VendorQueueOrderSummary {
  return {
    id: '01935f3d-0000-7000-8000-0000000000a1',
    shortCode: 'ABCD',
    userId: '01935f3d-0000-7000-8000-0000000000c1',
    customerName: 'Jane D.',
    status: 'placed',
    itemCount: 2,
    subtotalCents: 5_000,
    totalCents: 6_200,
    placedAt: '2026-07-02T15:00:00.000Z',
    statusChangedAt: '2026-07-02T15:28:00.000Z',
    acceptedAt: null,
    preppingAt: null,
    preparedAt: null,
    ...overrides,
  };
}

describe('RecentOrdersCard', () => {
  it('renders the empty state when there are no active orders', () => {
    render(<RecentOrdersCard orders={[]} now={NOW} />);
    expect(screen.getByTestId('recent-orders-empty')).toBeInTheDocument();
    expect(screen.getByText('No active orders')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-orders-list')).not.toBeInTheDocument();
  });

  it('renders one row per order with customer, short code, status, and total', () => {
    render(
      <RecentOrdersCard
        orders={[
          makeOrder({
            id: '1',
            customerName: 'Mia R.',
            shortCode: 'WXYZ',
            status: 'prepping',
            totalCents: 10_800,
          }),
          makeOrder({
            id: '2',
            customerName: null,
            shortCode: 'QRST',
            status: 'placed',
            totalCents: 5_420,
          }),
        ]}
        now={NOW}
      />,
    );

    const rows = screen.getAllByTestId('recent-orders-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Mia R.')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('#WXYZ · 2 items')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Prepping')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$108.00')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Guest customer')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('New order')).toBeInTheDocument();
  });

  it('links every row and the header into the live queue', () => {
    render(<RecentOrdersCard orders={[makeOrder()]} now={NOW} />);
    const links = screen.getAllByRole('link');
    expect(links.every((link) => link.getAttribute('href') === '/orders')).toBe(true);
  });

  it('singularizes the item count for a one-item order', () => {
    render(<RecentOrdersCard orders={[makeOrder({ itemCount: 1 })]} now={NOW} />);
    expect(screen.getByText('#ABCD · 1 item')).toBeInTheDocument();
  });
});
