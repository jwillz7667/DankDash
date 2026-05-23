import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import {
  QueueBoard,
  type QueueBoardRealtimeConfig,
} from '../../../components/orders/queue-board.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import { listVendorQueue, type VendorQueueOrderSummary } from '../../../lib/api/vendor-orders.js';
import { loadPublicEnv } from '../../../lib/env.js';
import {
  acceptVendorOrderAction,
  fetchVendorOrderAction,
  listActiveVendorQueueAction,
  markVendorOrderHandoffAction,
  markVendorOrderPreppedAction,
  markVendorOrderReadyAction,
  rejectVendorOrderAction,
} from '../../../lib/orders/actions.js';
import { type VendorOrderActions } from '../../../lib/orders/order-actions.js';

export const metadata: Metadata = {
  title: 'Orders — DankDash for Business',
};

/**
 * Vendor order queue. Server-component entry — fetches the initial
 * snapshot synchronously (Next.js will block first paint until the
 * API responds, which on a healthy queue is < 100ms), then hands the
 * orders to the client `QueueBoard` for reactive rendering.
 *
 * The realtime config (URL + access token + dispensary id) is read
 * here on the server and passed as a prop so the client component
 * doesn't have to know about Auth.js — the access token leaves the
 * server boundary only when an active dispensary is resolved.
 *
 * Drag-drop, the order detail drawer, and the polling fallback land
 * in follow-up phases (14.3 – 14.4); the page boundary stays here so
 * those layers only have to extend the board state, not re-introduce
 * the server-side fetch.
 *
 * Cache disabled (`force-dynamic`) — the queue is operator-critical
 * and must never serve a stale Next.js cache hit. Realtime keeps the
 * client snapshot fresh between page loads anyway.
 */
export const dynamic = 'force-dynamic';

export default async function OrdersPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  let initialOrders: readonly VendorQueueOrderSummary[];
  try {
    const result = await listVendorQueue(ctx.client);
    initialOrders = result.orders;
  } catch (error) {
    return <QueueFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const { NEXT_PUBLIC_REALTIME_URL } = loadPublicEnv();
  const realtime: QueueBoardRealtimeConfig = {
    url: NEXT_PUBLIC_REALTIME_URL,
    token: ctx.accessToken,
    dispensaryId: ctx.dispensary.id,
  };

  const actions: VendorOrderActions = {
    fetch: fetchVendorOrderAction,
    accept: acceptVendorOrderAction,
    reject: rejectVendorOrderAction,
    markPrepped: markVendorOrderPreppedAction,
    markReady: markVendorOrderReadyAction,
    markHandoff: markVendorOrderHandoffAction,
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">
            {ctx.dispensary.name}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Live order queue
          </h1>
          <p className="max-w-2xl text-sm text-muted">
            New orders, prepping work, ready-for-pickup bags, and out-for-delivery handoffs — every
            transition flows through the server-authoritative state machine.
          </p>
        </div>
      </header>
      <QueueBoard
        initialOrders={initialOrders}
        realtime={realtime}
        actions={actions}
        pollFetcher={listActiveVendorQueueAction}
      />
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
            Your account isn't yet linked to an active dispensary. Accept your invitation or contact
            your owner to grant access — the queue will appear here once a membership is active.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function QueueFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  // We don't surface raw error messages — leaks API internals and
  // confuses operators who can't act on them. The compliance team
  // gets the full envelope from server logs instead.
  void error;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Couldn't load the queue
          </h2>
          <p className="text-sm text-muted">
            The queue for {storeName} didn't load. Refresh the page; if this keeps happening, ping
            DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
