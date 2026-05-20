import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type VendorPayoutSummary } from '../../lib/api/vendor-payouts.js';
import { PayoutsListTable } from './payouts-list-table.js';

function makePayout(overrides: Partial<VendorPayoutSummary> = {}): VendorPayoutSummary {
  return {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    periodStart: '2026-05-17',
    periodEnd: '2026-05-18',
    grossCents: 125_000,
    feesCents: 1_500,
    netCents: 123_500,
    status: 'completed',
    scheduledFor: '2026-05-18',
    aeropayPayoutRef: 'aero_payout_123',
    initiatedAt: '2026-05-18T08:00:00.000Z',
    completedAt: '2026-05-18T08:15:00.000Z',
    failureReason: null,
    createdAt: '2026-05-18T08:00:00.000Z',
    ...overrides,
  };
}

describe('PayoutsListTable', () => {
  it('renders the empty placeholder when there are no payouts', () => {
    render(<PayoutsListTable payouts={[]} />);
    expect(screen.getByText(/No payouts yet/i)).toBeInTheDocument();
  });

  it('renders one row per payout with money formatted', () => {
    render(
      <PayoutsListTable
        payouts={[
          makePayout({ id: '01935f3d-0000-7000-8000-0000000000b1' }),
          makePayout({
            id: '01935f3d-0000-7000-8000-0000000000b2',
            periodStart: '2026-05-16',
            periodEnd: '2026-05-17',
            grossCents: 80_000,
            feesCents: 1_000,
            netCents: 79_000,
          }),
        ]}
      />,
    );

    expect(screen.getByText('$1,250.00')).toBeInTheDocument();
    expect(screen.getByText('$1,235.00')).toBeInTheDocument();
    expect(screen.getByText('$800.00')).toBeInTheDocument();
    expect(screen.getByText('$790.00')).toBeInTheDocument();
    expect(screen.getByText('−$15.00')).toBeInTheDocument();
    expect(screen.getByText('−$10.00')).toBeInTheDocument();
  });

  it('renders the period as a clickable link to the detail page', () => {
    render(<PayoutsListTable payouts={[makePayout()]} />);
    const link = screen.getByRole('link', { name: /May 17, 2026/i });
    expect(link.getAttribute('href')).toBe('/payouts/01935f3d-0000-7000-8000-0000000000b1');
  });

  it('renders the status badge with the human-readable label', () => {
    render(
      <PayoutsListTable
        payouts={[
          makePayout({ status: 'completed' }),
          makePayout({ id: '01935f3d-0000-7000-8000-0000000000b2', status: 'failed' }),
        ]}
      />,
    );
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders "—" for the fees column when feesCents is 0', () => {
    render(<PayoutsListTable payouts={[makePayout({ feesCents: 0 })]} />);
    const rows = screen.getAllByRole('row');
    // first row is the header; second is data
    expect(within(rows[1]!).getByText('—')).toBeInTheDocument();
  });

  it('renders "—" for the disbursed column when the payout has not completed', () => {
    render(<PayoutsListTable payouts={[makePayout({ status: 'pending', completedAt: null })]} />);
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]!).getByText('—')).toBeInTheDocument();
  });
});
