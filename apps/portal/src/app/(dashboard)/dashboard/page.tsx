import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { DashboardKpis } from '../../../components/dashboard/dashboard-kpis.js';
import { PayoutSnapshotCard } from '../../../components/dashboard/payout-snapshot-card.js';
import { RecentOrdersCard } from '../../../components/dashboard/recent-orders-card.js';
import { StoreStatusCard } from '../../../components/dashboard/store-status-card.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import { getVendorSalesAnalytics, type SalesAnalytics } from '../../../lib/api/vendor-analytics.js';
import { listVendorQueue, type ListVendorQueueResult } from '../../../lib/api/vendor-orders.js';
import { listVendorPayouts } from '../../../lib/api/vendor-payouts.js';
import { getVendorSettings } from '../../../lib/api/vendor-settings.js';
import {
  canViewStoreFinancials,
  greetingFor,
  resolveTodayWindow,
  selectPayoutSnapshot,
  selectRecentActivity,
  STORE_TIMEZONE,
  summarizeActiveOrders,
} from '../../../lib/dashboard/dashboard.js';

export const metadata: Metadata = {
  title: 'Dashboard — DankDash for Business',
};

/**
 * Vendor dashboard landing page. Server-renders live data from the
 * endpoints the operator already relies on elsewhere in the portal:
 *
 *   - KPIs + recent activity     — sales analytics (today) + order queue
 *                                  (available to every vendor role).
 *   - Store status + payouts     — settings + payouts, manager+ only;
 *                                  fetched best-effort so a hiccup on
 *                                  either degrades its own card without
 *                                  blanking the page.
 *
 * `force-dynamic` because every response is scoped to the caller's
 * `X-Dispensary-Id` and must never serve a cross-vendor cache hit.
 */
export const dynamic = 'force-dynamic';

const RECENT_ACTIVITY_LIMIT = 6;

export default async function DashboardPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  const now = new Date();

  let sales: SalesAnalytics;
  let queue: ListVendorQueueResult;
  try {
    [sales, queue] = await Promise.all([
      getVendorSalesAnalytics(ctx.client, resolveTodayWindow(now)),
      listVendorQueue(ctx.client),
    ]);
  } catch (error) {
    return <DashboardFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const active = summarizeActiveOrders(queue.orders);
  const recent = selectRecentActivity(queue.orders, RECENT_ACTIVITY_LIMIT);
  const showFinancials = canViewStoreFinancials(ctx.user.role);

  const [settingsResult, payoutsResult] = showFinancials
    ? await Promise.allSettled([getVendorSettings(ctx.client), listVendorPayouts(ctx.client)])
    : [null, null];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">
          {formatTodayLabel(now)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {greetingFor(now)}, {ctx.dispensary.name}
        </h1>
        <p className="text-sm text-muted">
          Today's numbers, your live queue, and what's next — all from the same server-authoritative
          data the rest of the portal runs on.
        </p>
      </header>

      <DashboardKpis sales={sales} active={active} />

      {showFinancials ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <RecentOrdersCard orders={recent} now={now} className="lg:col-span-2" />
          <div className="flex flex-col gap-6">
            {settingsResult?.status === 'fulfilled' ? (
              <StoreStatusCard settings={settingsResult.value} now={now} />
            ) : (
              <CardLoadError title="Store status" />
            )}
            {payoutsResult?.status === 'fulfilled' ? (
              <PayoutSnapshotCard snapshot={selectPayoutSnapshot(payoutsResult.value.payouts)} />
            ) : (
              <CardLoadError title="Payouts" />
            )}
          </div>
        </section>
      ) : (
        <RecentOrdersCard orders={recent} now={now} />
      )}
    </div>
  );
}

function formatTodayLabel(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: STORE_TIMEZONE,
  }).format(now);
}

function CardLoadError({ title }: { readonly title: string }): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-1.5 text-center">
        <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-warning-soft text-warning">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
        </div>
        <p className="text-sm font-medium text-secondary">{title} unavailable</p>
        <p className="text-xs text-muted">Refresh to try again.</p>
      </CardBody>
    </Card>
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
            Your account isn't yet linked to an active dispensary. Accept your invitation or contact
            your owner to grant access — your dashboard will appear here once a membership is
            active.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function DashboardFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  // Raw error envelopes leak API internals and aren't actionable for an
  // operator; the full context lands in server logs. Same posture as the
  // orders and analytics pages.
  void error;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Couldn't load your dashboard
          </h2>
          <p className="text-sm text-muted">
            We couldn't load today's metrics for {storeName}. Refresh the page; if it keeps failing,
            ping DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
