import { AlertTriangle } from 'lucide-react';
import { type ReactNode } from 'react';
import { resolveWindowFromSearchParams } from '../../../../components/analytics/date-range-picker.js';
import { DeadInventoryTable } from '../../../../components/analytics/dead-inventory-table.js';
import { ReorderRateCard } from '../../../../components/analytics/reorder-rate-card.js';
import { TopProductsList } from '../../../../components/analytics/top-products-list.js';
import {
  Card,
  CardBody,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '../../../../components/ui/card.js';
import { formatWindowLabel } from '../../../../lib/analytics/format.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import {
  getVendorProductsAnalytics,
  type ProductsAnalytics,
} from '../../../../lib/api/vendor-analytics.js';

/**
 * The Products tab. Best-sellers (top 25) + dead inventory (slowest 50)
 * + the period's customer reorder rate. Single GET to
 * `/v1/vendor/analytics/products`; same caching policy as the sales tab.
 */
export const dynamic = 'force-dynamic';

interface ProductsPageProps {
  readonly searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function ProductsAnalyticsPage({
  searchParams,
}: ProductsPageProps): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  const resolvedParams = await searchParams;
  const window = resolveWindowFromSearchParams(resolvedParams);

  let analytics: ProductsAnalytics;
  try {
    analytics = await getVendorProductsAnalytics(ctx.client, window);
  } catch (error) {
    return <AnalyticsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  return (
    <div className="flex flex-col gap-6" data-testid="analytics-products">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">
        {formatWindowLabel(analytics.from, analytics.to)}
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ReorderRateCard reorderRate={analytics.reorderRate} />
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Best sellers</CardTitle>
              <CardSubtitle>Top products by revenue across the window.</CardSubtitle>
            </div>
          </CardHeader>
          <CardBody>
            <TopProductsList products={analytics.bestSellers} limit={10} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Dead inventory</CardTitle>
            <CardSubtitle>
              Active listings with stock on hand that didn't sell in this window. Consider a
              promotion or pulling the listing.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardBody className="px-0 py-0">
          <DeadInventoryTable rows={analytics.deadInventory} />
        </CardBody>
      </Card>
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
            We couldn't load product analytics for {storeName}. Refresh the page; if it keeps
            failing, ping DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
