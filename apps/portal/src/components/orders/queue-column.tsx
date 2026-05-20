import { type ReactNode } from 'react';
import { type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { type QueueColumnConfig } from '../../lib/orders/queue-columns.js';
import { Badge } from '../ui/badge.js';
import { QueueCard } from './queue-card.js';

export interface QueueColumnProps {
  readonly column: QueueColumnConfig;
  readonly orders: readonly VendorQueueOrderSummary[];
  readonly now: Date;
}

/**
 * Single kanban column. Renders a sticky header (label + count badge
 * + helper subtitle) and a scrollable card list. Empty columns render
 * a single muted line so the four-up layout doesn't collapse when one
 * lane is quiet — keeps spatial muscle memory intact for the operator.
 */
export function QueueColumn({ column, orders, now }: QueueColumnProps): ReactNode {
  return (
    <section
      aria-label={`${column.label} column`}
      className="flex h-full flex-col rounded-2xl border border-slate-200 bg-slate-50/50"
      data-column-key={column.key}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">{column.label}</h3>
            <Badge tone={column.tone} aria-label={`${orders.length.toString()} orders`}>
              {orders.length}
            </Badge>
          </div>
          <p className="text-xs text-slate-500">{column.helper}</p>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {orders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-6 text-center text-xs text-slate-400">
            No orders.
          </p>
        ) : (
          orders.map((order) => <QueueCard key={order.id} order={order} now={now} />)
        )}
      </div>
    </section>
  );
}
