import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HourlyHeatmap } from './hourly-heatmap.js';

describe('HourlyHeatmap', () => {
  it('renders the empty-window placeholder when no buckets', () => {
    render(<HourlyHeatmap buckets={[]} />);
    expect(screen.getByText(/No orders in this window/i)).toBeInTheDocument();
  });

  it('renders a 7x24 grid with day labels and the order count in occupied cells', () => {
    render(
      <HourlyHeatmap
        buckets={[
          { dayOfWeek: 5, hour: 19, orderCount: 4, revenueCents: 32_000 },
          { dayOfWeek: 0, hour: 12, orderCount: 1, revenueCents: 8_000 },
        ]}
      />,
    );
    // All seven day-of-week labels present
    for (const label of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The Friday-19:00 cell has aria-label with "4 orders"
    expect(screen.getByLabelText('Fri 19:00: 4 orders')).toBeInTheDocument();
    // The Sunday-12:00 cell has "1 orders"
    expect(screen.getByLabelText('Sun 12:00: 1 orders')).toBeInTheDocument();
  });

  it('marks cells with no orders as label "0 orders"', () => {
    render(
      <HourlyHeatmap buckets={[{ dayOfWeek: 1, hour: 14, orderCount: 1, revenueCents: 1_000 }]} />,
    );
    // 7 * 24 = 168 cells; only one occupied so the rest are zero. Spot-check a random empty cell.
    expect(screen.getByLabelText('Mon 03:00: 0 orders')).toBeInTheDocument();
  });
});
