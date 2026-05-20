import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { QUEUE_COLUMNS } from '../../lib/orders/queue-columns.js';
import { QueueColumn } from './queue-column.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const NEW_COL = QUEUE_COLUMNS[0]!;

function order(
  overrides: Partial<VendorQueueOrderSummary> & { readonly id: string },
): VendorQueueOrderSummary {
  return {
    shortCode: 'A1B2',
    userId: '01935f3d-0000-7000-8000-000000000abc',
    customerName: 'Mia Reyes',
    status: 'placed',
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

describe('QueueColumn', () => {
  it('renders the column label, helper text, and count badge', () => {
    render(
      <QueueColumn
        column={NEW_COL}
        orders={[order({ id: 'o1' }), order({ id: 'o2' })]}
        now={NOW}
      />,
    );

    expect(screen.getByRole('region', { name: /New column/u })).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Awaiting acceptance')).toBeInTheDocument();
    expect(screen.getByLabelText('2 orders')).toHaveTextContent('2');
  });

  it('renders the empty-state placeholder when the column is empty (preserves layout)', () => {
    render(<QueueColumn column={NEW_COL} orders={[]} now={NOW} />);

    expect(screen.getByText('No orders.')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-card')).not.toBeInTheDocument();
  });

  it('renders one QueueCard per order, in the supplied order', () => {
    const orders = [
      order({ id: 'first', customerName: 'Aaron' }),
      order({ id: 'second', customerName: 'Beth' }),
    ];
    const { container } = render(<QueueColumn column={NEW_COL} orders={orders} now={NOW} />);
    const cards = container.querySelectorAll('[data-testid="queue-card"]');
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText('Aaron')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('Beth')).toBeInTheDocument();
  });

  it('tags the section with data-column-key so realtime patching can target it', () => {
    const { container } = render(<QueueColumn column={NEW_COL} orders={[]} now={NOW} />);
    const section = container.querySelector('section');
    expect(section?.getAttribute('data-column-key')).toBe('new');
  });
});
