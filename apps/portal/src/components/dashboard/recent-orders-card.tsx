import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { cn } from '../../lib/cn.js';
import { orderStatusLabel, orderStatusTone } from '../../lib/dashboard/dashboard.js';
import { formatMoney, formatRelativeTime, formatShortCode } from '../../lib/orders/format.js';
import { Badge } from '../ui/badge.js';
import { Card, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';

export interface RecentOrdersCardProps {
  /** Active-queue orders, already sliced + ordered newest-first. */
  readonly orders: readonly VendorQueueOrderSummary[];
  /** Shared "now" reference so every row's relative time agrees. */
  readonly now: Date;
  /** Grid placement — the page owns the column span. */
  readonly className?: string;
}

/**
 * Recent-activity rail. Each row is the latest movement on an active
 * order and links into the live queue at `/orders`, so a glance here
 * flows straight into the operator's working surface. Renders an empty
 * state when the queue is quiet rather than a fabricated feed.
 */
export function RecentOrdersCard({ orders, now, className }: RecentOrdersCardProps): ReactNode {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <div className="space-y-0.5">
          <CardTitle>Recent activity</CardTitle>
          <CardSubtitle>The latest orders moving through your queue.</CardSubtitle>
        </div>
        <Link
          href="/orders"
          className="text-xs font-medium text-moss-700 hover:text-moss-800"
          data-testid="recent-orders-view-all"
        >
          View queue
        </Link>
      </CardHeader>
      {orders.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-1.5 px-6 py-12 text-center"
          data-testid="recent-orders-empty"
        >
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-subtle text-muted"
          >
            <Inbox className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-secondary">No active orders</p>
          <p className="max-w-sm text-sm text-muted">
            New orders will appear here the moment a customer checks out.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-subtle" data-testid="recent-orders-list">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href="/orders"
                className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-surface-muted"
                data-testid="recent-orders-row"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-sm font-medium text-foreground">
                    {order.customerName ?? 'Guest customer'}
                  </p>
                  <p className="font-tabular text-xs text-muted">
                    {formatShortCode(order.shortCode)} ·{' '}
                    {order.itemCount === 1 ? '1 item' : `${order.itemCount.toString()} items`}
                  </p>
                </div>
                <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
                <div className="flex w-24 flex-col items-end gap-0.5 font-tabular">
                  <span className="text-sm font-medium text-foreground">
                    {formatMoney(order.totalCents)}
                  </span>
                  <span className="text-2xs text-muted">
                    {formatRelativeTime(order.statusChangedAt, now)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
