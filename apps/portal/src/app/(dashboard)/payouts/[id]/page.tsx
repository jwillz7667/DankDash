import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { PayoutDetail } from '../../../../components/payouts/payout-detail.js';
import { Card, CardBody } from '../../../../components/ui/card.js';
import { ApiError } from '../../../../lib/api/client.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import { getVendorPayout, type VendorPayoutDetail } from '../../../../lib/api/vendor-payouts.js';

export const metadata: Metadata = {
  title: 'Payout — DankDash for Business',
};

/**
 * Vendor payout detail (Phase 15.3). Server-renders the full breakdown
 * — KPIs, disbursement timeline, constituent orders — off a single
 * `GET /v1/vendor/payouts/:id` call. `force-dynamic` because the
 * payload is per-vendor and must not be cached across principals.
 *
 * The API returns 404 for both "doesn't exist" and "isn't yours" so a
 * cross-tenant probe can't distinguish the two. Either case bubbles up
 * here as an `ApiError` with `status === 404`, which we route to the
 * Next.js not-found page rather than the generic error fallback.
 */
export const dynamic = 'force-dynamic';

interface PayoutDetailPageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function PayoutDetailPage({
  params,
}: PayoutDetailPageProps): Promise<ReactNode> {
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

  const { id } = await params;

  let payout: VendorPayoutDetail;
  try {
    payout = await getVendorPayout(ctx.client, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    return <PayoutsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PayoutDetail payout={payout} />
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
            Couldn't load payout
          </h2>
          <p className="text-sm text-slate-500">
            We couldn't load this payout for {storeName}. Refresh the page; if it keeps failing,
            ping DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
