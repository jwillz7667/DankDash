import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { PayoutsListTable } from '../../../components/payouts/payouts-list-table.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import { listVendorPayouts, type VendorPayoutListResult } from '../../../lib/api/vendor-payouts.js';

export const metadata: Metadata = {
  title: 'Payouts — DankDash for Business',
};

/**
 * Vendor payouts list (Phase 15.3). Server-renders the table off a
 * single `GET /v1/vendor/payouts` call. `force-dynamic` because the
 * data is per-vendor (X-Dispensary-Id is session-scoped) and must not
 * be cached across principals.
 *
 * Budtenders are filtered upstream by the sidebar role gate (Phase 13)
 * and the API's `@Roles('manager', 'owner', 'admin', 'superadmin')`
 * guard. A budtender who navigates directly here gets redirected to
 * /dashboard by the role check; if they bypass that, the API returns
 * 403 and the error boundary kicks in.
 */
export const dynamic = 'force-dynamic';

export default async function PayoutsPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx === null) {
    redirect('/login');
  }
  if (ctx.dispensary === null) {
    return <NoDispensaryContext />;
  }
  if (ctx.dispensary.staffRole === 'budtender') {
    redirect('/dashboard');
  }

  let result: VendorPayoutListResult;
  try {
    result = await listVendorPayouts(ctx.client);
  } catch (error) {
    return <PayoutsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Payouts</h1>
        <p className="text-sm text-slate-500">
          Daily settlement runs from Aeropay. Click a row to see the orders that contributed to each
          payout.
        </p>
      </header>
      <PayoutsListTable payouts={result.payouts} />
    </div>
  );
}

function NoDispensaryContext(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-slate-900">
            No dispensary context
          </h2>
          <p className="text-sm text-slate-500">
            Payouts are scoped to an active dispensary. Accept your invitation or contact your owner
            to grant access.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function PayoutsFetchError({
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
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-700">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-slate-900">
            Couldn't load payouts
          </h2>
          <p className="text-sm text-slate-500">
            We couldn't load payouts for {storeName}. Refresh the page; if it keeps failing, ping
            DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
