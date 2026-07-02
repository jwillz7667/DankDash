import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type VendorPayoutSummary } from '../../lib/api/vendor-payouts.js';
import { type PayoutSnapshot } from '../../lib/dashboard/dashboard.js';
import { PayoutSnapshotCard } from './payout-snapshot-card.js';

function makePayout(overrides: Partial<VendorPayoutSummary> = {}): VendorPayoutSummary {
  return {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    periodStart: '2026-06-30',
    periodEnd: '2026-07-01',
    grossCents: 125_000,
    feesCents: 1_500,
    netCents: 123_500,
    status: 'completed',
    scheduledFor: '2026-07-01',
    aeropayPayoutRef: 'aero_1',
    initiatedAt: '2026-07-01T08:00:00.000Z',
    completedAt: '2026-07-01T08:15:00.000Z',
    failureReason: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('PayoutSnapshotCard', () => {
  it('renders the empty state when nothing is paid or scheduled', () => {
    const snapshot: PayoutSnapshot = { last: null, next: null };
    render(<PayoutSnapshotCard snapshot={snapshot} />);
    expect(screen.getByTestId('payout-snapshot-empty')).toBeInTheDocument();
    expect(screen.getByText('No payouts yet')).toBeInTheDocument();
  });

  it('renders the last deposit net amount and status label', () => {
    const snapshot: PayoutSnapshot = {
      last: makePayout({ netCents: 123_500, status: 'completed' }),
      next: null,
    };
    render(<PayoutSnapshotCard snapshot={snapshot} />);
    const last = screen.getByTestId('payout-last');
    expect(within(last).getByText('$1,235.00')).toBeInTheDocument();
    expect(within(last).getByText(/Paid/)).toBeInTheDocument();
    expect(screen.getByTestId('payout-next')).toHaveTextContent('Nothing scheduled');
  });

  it('renders the next scheduled deposit with its net amount', () => {
    const snapshot: PayoutSnapshot = {
      last: null,
      next: makePayout({
        id: '01935f3d-0000-7000-8000-0000000000b2',
        status: 'pending',
        netCents: 80_000,
        scheduledFor: '2026-07-05',
      }),
    };
    render(<PayoutSnapshotCard snapshot={snapshot} />);
    expect(screen.getByTestId('payout-last')).toHaveTextContent('None yet');
    const next = screen.getByTestId('payout-next');
    expect(within(next).getByText('$800.00')).toBeInTheDocument();
    expect(within(next).getByText(/Pending/)).toBeInTheDocument();
  });

  it('links to the full payouts ledger', () => {
    render(<PayoutSnapshotCard snapshot={{ last: makePayout(), next: null }} />);
    expect(screen.getByRole('link', { name: /View all/i }).getAttribute('href')).toBe('/payouts');
  });
});
