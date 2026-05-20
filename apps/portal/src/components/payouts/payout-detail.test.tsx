import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type VendorPayoutDetail } from '../../lib/api/vendor-payouts.js';
import { PayoutDetail } from './payout-detail.js';

function makeDetail(overrides: Partial<VendorPayoutDetail> = {}): VendorPayoutDetail {
  const base: VendorPayoutDetail = {
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
    orders: [
      {
        id: '01935f3d-0000-7000-8000-0000000000c1',
        shortCode: 'DD-AAAA-01',
        deliveredAt: '2026-05-17T22:13:00.000Z',
        subtotalCents: 4500,
        discountCents: 0,
        totalCents: 5000,
        customerFirstName: 'Jane',
        customerLastName: 'Doe',
      },
      {
        id: '01935f3d-0000-7000-8000-0000000000c2',
        shortCode: 'DD-BBBB-02',
        deliveredAt: '2026-05-17T19:45:00.000Z',
        subtotalCents: 8000,
        discountCents: 500,
        totalCents: 8200,
        customerFirstName: 'Alex',
        customerLastName: null,
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('PayoutDetail', () => {
  it('renders the period header and a back link to the payouts list', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    expect(screen.getByRole('heading', { name: /May 17, 2026/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All payouts/i }).getAttribute('href')).toBe(
      '/payouts',
    );
  });

  it('renders the three KPI cards (gross / fees / net) with money formatted', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    expect(screen.getByText('Gross')).toBeInTheDocument();
    expect(screen.getByText('Fees')).toBeInTheDocument();
    expect(screen.getByText('Net deposit')).toBeInTheDocument();
    expect(screen.getByText('$1,250.00')).toBeInTheDocument();
    expect(screen.getByText('-$15.00')).toBeInTheDocument();
    expect(screen.getByText('$1,235.00')).toBeInTheDocument();
  });

  it('renders the aeropay reference in the subtitle when set', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    expect(screen.getByText(/aero_payout_123/)).toBeInTheDocument();
  });

  it('renders "Awaiting Aeropay disbursement" when no aeropay ref yet', () => {
    render(
      <PayoutDetail
        payout={makeDetail({
          status: 'pending',
          aeropayPayoutRef: null,
          initiatedAt: null,
          completedAt: null,
        })}
      />,
    );
    expect(screen.getByText(/Awaiting Aeropay disbursement/i)).toBeInTheDocument();
  });

  it('renders the failure reason alert for failed payouts', () => {
    render(
      <PayoutDetail
        payout={makeDetail({ status: 'failed', failureReason: 'aeropay returned 500' })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/aeropay returned 500/);
  });

  it('renders one row per constituent order with customer short name', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    expect(screen.getByText('DD-AAAA-01')).toBeInTheDocument();
    expect(screen.getByText('DD-BBBB-02')).toBeInTheDocument();
    expect(screen.getByText('Jane D.')).toBeInTheDocument();
    // Alex has no last name so just "Alex".
    expect(screen.getByText('Alex')).toBeInTheDocument();
  });

  it('renders the order totals footer = sum of totalCents', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    // 5000 + 8200 = 13200 cents = $132.00
    expect(screen.getByText('$132.00')).toBeInTheDocument();
  });

  it('renders empty placeholder when no orders contributed', () => {
    render(<PayoutDetail payout={makeDetail({ orders: [] })} />);
    expect(screen.getByText(/No orders delivered inside this period/i)).toBeInTheDocument();
  });

  it('renders a discount cell with a minus prefix when the order had a discount', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    // DD-BBBB-02 had a 500-cent discount → "−$5.00"
    expect(screen.getByText('−$5.00')).toBeInTheDocument();
  });

  it('renders the disbursement timeline (scheduled / initiated / completed)', () => {
    render(<PayoutDetail payout={makeDetail()} />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Initiated')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('2026-05-18')).toBeInTheDocument();
    // Initiated rendered as a Central-timezone string
    const initiated = screen.getAllByText(/May 18, 2026/);
    expect(initiated.length).toBeGreaterThan(0);
  });
});
