import { BarChart3, DollarSign, PackageCheck, Timer } from 'lucide-react';
import { type ReactNode } from 'react';
import { deltaForBigger, formatCompactMoney, formatMoney } from '../../lib/analytics/format.js';
import { type SalesAnalytics } from '../../lib/api/vendor-analytics.js';
import { type ActiveOrdersSummary } from '../../lib/dashboard/dashboard.js';
import { StatCard } from '../ui/stat-card.js';

export interface DashboardKpisProps {
  /** Today-so-far sales, keyed on `delivered_at`, with prior-period baseline. */
  readonly sales: SalesAnalytics;
  /** Rollup of orders currently on the vendor queue. */
  readonly active: ActiveOrdersSummary;
}

/**
 * The four landing KPIs, rendered off live data:
 *
 *   - Sales today       — delivered revenue since local midnight, delta
 *                         vs the equal prior window the API returns.
 *   - Delivered today   — count of delivered orders (same window).
 *   - Active now        — orders currently on the queue; the delta line
 *                         calls out how many are awaiting acceptance.
 *   - Avg order         — average delivered order value today.
 *
 * The "active" card carries no period delta — it's an instantaneous
 * gauge, not a trend — so its sub-line surfaces the actionable count
 * instead.
 */
export function DashboardKpis({ sales, active }: DashboardKpisProps): ReactNode {
  const revenueDelta = deltaForBigger(sales.revenueCents, sales.previousRevenueCents);
  const orderDelta = deltaForBigger(sales.orderCount, sales.previousOrderCount);
  const aovDelta = deltaForBigger(sales.avgOrderValueCents, sales.previousAvgOrderValueCents);

  const awaiting = active.awaitingAccept;
  const activeDelta =
    awaiting > 0
      ? { label: `${awaiting.toString()} awaiting accept`, trend: 'up' as const }
      : { label: 'all caught up', trend: 'flat' as const };

  return (
    <section
      aria-label="Today's key metrics"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="dashboard-kpis"
    >
      <StatCard
        label="Sales today"
        value={formatCompactMoney(sales.revenueCents)}
        delta={revenueDelta.label}
        trend={revenueDelta.trend}
        icon={<DollarSign aria-hidden="true" className="h-4 w-4" />}
        highlight
      />
      <StatCard
        label="Delivered today"
        value={sales.orderCount.toString()}
        delta={orderDelta.label}
        trend={orderDelta.trend}
        icon={<PackageCheck aria-hidden="true" className="h-4 w-4" />}
      />
      <StatCard
        label="Active now"
        value={active.total.toString()}
        delta={activeDelta.label}
        trend={activeDelta.trend}
        icon={<Timer aria-hidden="true" className="h-4 w-4" />}
      />
      <StatCard
        label="Avg order today"
        value={formatMoney(sales.avgOrderValueCents)}
        delta={aovDelta.label}
        trend={aovDelta.trend}
        icon={<BarChart3 aria-hidden="true" className="h-4 w-4" />}
      />
    </section>
  );
}
