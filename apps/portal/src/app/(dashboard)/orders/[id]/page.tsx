import { ArrowLeft } from 'lucide-react';
import { type Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { DeliveryMap } from '../../../../components/orders/delivery-map.js';
import { Badge } from '../../../../components/ui/badge.js';
import { Card, CardBody } from '../../../../components/ui/card.js';
import { ApiError } from '../../../../lib/api/client.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import { getVendorOrder, type VendorOrderDetail } from '../../../../lib/api/vendor-orders.js';
import { loadPublicEnv } from '../../../../lib/env.js';
import { formatMoney, formatShortCode } from '../../../../lib/orders/format.js';

export const metadata: Metadata = {
  title: 'Order — DankDash for Business',
};

/**
 * Vendor per-order detail with the live delivery map. Server-renders the
 * order summary + the SSR map snapshot (pickup/dropoff/last-known driver)
 * off `GET /v1/vendor/orders/:id`, then the client `DeliveryMap`
 * subscribes to `driver:location` and animates the driver marker.
 *
 * `force-dynamic` because the payload is per-vendor and must not be
 * cached across principals. Cross-tenant / missing orders surface as a
 * 404 (the API returns 404 for both) → Next.js not-found.
 */
export const dynamic = 'force-dynamic';

interface OrderDetailPageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function OrderDetailPage({
  params,
}: OrderDetailPageProps): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx === null) {
    redirect('/login');
  }
  if (ctx.dispensary === null) {
    redirect('/dashboard');
  }

  const { id } = await params;

  let order: VendorOrderDetail;
  try {
    order = await getVendorOrder(ctx.client, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    return <OrderFetchError error={error} />;
  }

  const { NEXT_PUBLIC_REALTIME_URL } = loadPublicEnv();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/orders"
          className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to queue
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">
            {ctx.dispensary.name}
          </p>
          <h1 className="font-tabular text-3xl font-semibold tracking-tight text-foreground">
            {formatShortCode(order.shortCode)}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="info">{formatStatus(order.status)}</Badge>
          <span className="font-tabular text-lg font-medium text-foreground">
            {formatMoney(order.totalCents)}
          </span>
        </div>
      </header>

      <DeliveryMap
        orderId={order.id}
        status={order.status}
        delivery={order.delivery}
        realtime={{
          url: NEXT_PUBLIC_REALTIME_URL,
          token: ctx.accessToken,
          dispensaryId: ctx.dispensary.id,
        }}
      />
    </div>
  );
}

/** "en_route_pickup" → "En Route Pickup". */
function formatStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function OrderFetchError({ error }: { readonly error: unknown }): ReactNode {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-2 text-center">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Couldn&apos;t load this order
          </h2>
          <p className="text-sm text-muted">{message}</p>
          <Link
            href="/orders"
            className="inline-flex items-center gap-1 text-sm font-medium text-moss-700 hover:text-moss-800"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to queue
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
