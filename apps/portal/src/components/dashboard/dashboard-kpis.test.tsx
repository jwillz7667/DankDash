import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type SalesAnalytics } from '../../lib/api/vendor-analytics.js';
import { type ActiveOrdersSummary } from '../../lib/dashboard/dashboard.js';
import { DashboardKpis } from './dashboard-kpis.js';

function makeSales(overrides: Partial<SalesAnalytics> = {}): SalesAnalytics {
  return {
    from: '2026-07-02T05:00:00.000Z',
    to: '2026-07-02T18:30:00.000Z',
    revenueCents: 1_248_600,
    previousRevenueCents: 1_100_000,
    orderCount: 47,
    previousOrderCount: 40,
    avgOrderValueCents: 7_340,
    previousAvgOrderValueCents: 7_100,
    hourly: [],
    topProducts: [],
    ...overrides,
  };
}

function makeActive(overrides: Partial<ActiveOrdersSummary> = {}): ActiveOrdersSummary {
  return { total: 14, awaitingAccept: 3, inPrep: 6, readyForHandoff: 5, ...overrides };
}

describe('DashboardKpis', () => {
  it('renders the four live KPI cards with labels', () => {
    render(<DashboardKpis sales={makeSales()} active={makeActive()} />);
    expect(screen.getByText('Sales today')).toBeInTheDocument();
    expect(screen.getByText('Delivered today')).toBeInTheDocument();
    expect(screen.getByText('Active now')).toBeInTheDocument();
    expect(screen.getByText('Avg order today')).toBeInTheDocument();
  });

  it('shows delivered order count and active queue total from the data', () => {
    render(
      <DashboardKpis sales={makeSales({ orderCount: 47 })} active={makeActive({ total: 14 })} />,
    );
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
  });

  it('surfaces the awaiting-accept count on the active card', () => {
    render(<DashboardKpis sales={makeSales()} active={makeActive({ awaitingAccept: 3 })} />);
    expect(screen.getByText('3 awaiting accept')).toBeInTheDocument();
  });

  it('reads "all caught up" when nothing is awaiting acceptance', () => {
    render(<DashboardKpis sales={makeSales()} active={makeActive({ awaitingAccept: 0 })} />);
    expect(screen.getByText('all caught up')).toBeInTheDocument();
  });
});
