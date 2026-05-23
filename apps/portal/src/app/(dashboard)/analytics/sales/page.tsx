import { AlertTriangle, BarChart3, DollarSign, ShoppingCart } from 'lucide-react';
import { type ReactNode } from 'react';
import { resolveWindowFromSearchParams } from '../../../../components/analytics/date-range-picker.js';
import { HourlyHeatmap } from '../../../../components/analytics/hourly-heatmap.js';
import { RevenueChart } from '../../../../components/analytics/revenue-chart.js';
import { TopProductsList } from '../../../../components/analytics/top-products-list.js';
import {
  Card,
  CardBody,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '../../../../components/ui/card.js';
import { StatCard } from '../../../../components/ui/stat-card.js';
import {
  deltaForBigger,
  formatCompactMoney,
  formatMoney,
  formatWindowLabel,
} from '../../../../lib/analytics/format.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import {
  getVendorSalesAnalytics,
  type SalesAnalytics,
} from '../../../../lib/api/vendor-analytics.js';

/**
 * The Sales tab. Server-renders the KPIs + chart + heatmap + top-products
 * list from a single `/v1/vendor/analytics/sales` call. `force-dynamic`
 * because the window is URL-driven and the data must not be cached
 * across vendors (`X-Dispensary-Id` differs by session).
 */
export const dynamic = 'force-dynamic';

interface SalesPageProps {
  readonly searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function SalesPage({ searchParams }: SalesPageProps): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  const resolvedParams = await searchParams;
  const window = resolveWindowFromSearchParams(resolvedParams);

  let analytics: SalesAnalytics;
  try {
    analytics = await getVendorSalesAnalytics(ctx.client, window);
  } catch (error) {
    return <AnalyticsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const revenueDelta = deltaForBigger(analytics.revenueCents, analytics.previousRevenueCents);
  const orderDelta = deltaForBigger(analytics.orderCount, analytics.previousOrderCount);
  const aovDelta = deltaForBigger(
    analytics.avgOrderValueCents,
    analytics.previousAvgOrderValueCents,
  );

  return (
    <div className="flex flex-col gap-6" data-testid="analytics-sales">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">
        {formatWindowLabel(analytics.from, analytics.to)}
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Revenue"
          value={formatCompactMoney(analytics.revenueCents)}
          delta={revenueDelta.label}
          trend={revenueDelta.trend}
          icon={<DollarSign aria-hidden="true" className="h-4 w-4" />}
          highlight
        />
        <StatCard
          label="Orders"
          value={analytics.orderCount.toString()}
          delta={orderDelta.label}
          trend={orderDelta.trend}
          icon={<ShoppingCart aria-hidden="true" className="h-4 w-4" />}
        />
        <StatCard
          label="Avg order"
          value={formatMoney(analytics.avgOrderValueCents)}
          delta={aovDelta.label}
          trend={aovDelta.trend}
          icon={<BarChart3 aria-hidden="true" className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Revenue trend</CardTitle>
            <CardSubtitle>Daily revenue across the selected window.</CardSubtitle>
          </div>
        </CardHeader>
        <CardBody>
          <RevenueChart from={analytics.from} to={analytics.to} hourly={analytics.hourly} />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>Hours your customers order</CardTitle>
              <CardSubtitle>
                Order count by local hour (America/Chicago). Brighter = busier.
              </CardSubtitle>
            </div>
          </CardHeader>
          <CardBody>
            <HourlyHeatmap buckets={analytics.hourly} />
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Top products</CardTitle>
              <CardSubtitle>Best sellers by revenue.</CardSubtitle>
            </div>
          </CardHeader>
          <CardBody>
            <TopProductsList products={analytics.topProducts} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function NoDispensaryContext(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            No dispensary context
          </h2>
          <p className="text-sm text-muted">
            Analytics are scoped to an active dispensary. Accept your invitation or contact your
            owner to grant access.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function AnalyticsFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  void error;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Couldn't load analytics
          </h2>
          <p className="text-sm text-muted">
            We couldn't load sales analytics for {storeName}. Refresh the page; if it keeps failing,
            ping DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
