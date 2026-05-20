import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { QueueCard } from './queue-card.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');

function order(overrides: Partial<VendorQueueOrderSummary> = {}): VendorQueueOrderSummary {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    shortCode: 'A1B2',
    userId: '01935f3d-0000-7000-8000-000000000abc',
    customerName: 'Mia Reyes',
    status: 'placed',
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

describe('QueueCard', () => {
  it('renders the customer name, short code, item count, age and money total', () => {
    render(<QueueCard order={order()} now={NOW} />);

    expect(screen.getByText('Mia Reyes')).toBeInTheDocument();
    expect(screen.getByText('#A1B2')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    expect(screen.getByText('$62.10')).toBeInTheDocument();
  });

  it('renders "Guest customer" when the customer name is null (anonymized orders)', () => {
    render(<QueueCard order={order({ customerName: null })} now={NOW} />);
    expect(screen.getByText('Guest customer')).toBeInTheDocument();
  });

  it('uses singular "1 item" copy for orders with a single line', () => {
    render(<QueueCard order={order({ itemCount: 1 })} now={NOW} />);
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('exposes the order id via data-order-id so realtime patching can locate the node', () => {
    const { container } = render(<QueueCard order={order()} now={NOW} />);
    const card = container.querySelector('[data-testid="queue-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-order-id')).toBe('01935f3d-0000-7000-8000-000000000001');
  });

  it('renders the absolute placedAt on the age dd via title for hover precision', () => {
    const { container } = render(<QueueCard order={order()} now={NOW} />);
    const titled = container.querySelector('[title="2026-05-19T11:55:00.000Z"]');
    expect(titled).not.toBeNull();
  });

  describe('interactivity (onSelect)', () => {
    it('renders as a button and fires onSelect with the order id on click', () => {
      const onSelect = vi.fn();
      const { container } = render(<QueueCard order={order()} now={NOW} onSelect={onSelect} />);

      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.tagName).toBe('BUTTON');

      fireEvent.click(card!);
      expect(onSelect).toHaveBeenCalledWith('01935f3d-0000-7000-8000-000000000001');
    });

    it('falls back to a non-interactive article when onSelect is not supplied', () => {
      const { container } = render(<QueueCard order={order()} now={NOW} />);
      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.tagName).toBe('ARTICLE');
    });
  });

  describe('age escalation tone', () => {
    it('paints the success tone for orders under 5 minutes old', () => {
      const { container } = render(
        <QueueCard order={order({ statusChangedAt: '2026-05-19T11:57:00.000Z' })} now={NOW} />,
      );
      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.getAttribute('data-age-tone')).toBe('success');
    });

    it('paints the warning tone for orders 5–10 minutes old', () => {
      const { container } = render(
        <QueueCard order={order({ statusChangedAt: '2026-05-19T11:53:00.000Z' })} now={NOW} />,
      );
      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.getAttribute('data-age-tone')).toBe('warning');
    });

    it('paints the danger tone for orders 10 minutes or older', () => {
      const { container } = render(
        <QueueCard order={order({ statusChangedAt: '2026-05-19T11:45:00.000Z' })} now={NOW} />,
      );
      const card = container.querySelector('[data-testid="queue-card"]');
      expect(card?.getAttribute('data-age-tone')).toBe('danger');
    });
  });
});
