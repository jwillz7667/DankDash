/**
 * Reorder-rate card — the percentage of customers in the window who
 * placed more than one delivered order with this dispensary. A simple
 * percent + the raw "X of Y customers" breakdown sits next to the big
 * number so the percent isn't reported in a vacuum (a 50% reorder rate
 * is a great signal in a 200-customer week, less so in a 4-customer
 * week).
 */
import { Repeat } from 'lucide-react';
import { type ReactNode } from 'react';
import { formatPercent } from '../../lib/analytics/format.js';
import { type ReorderRate } from '../../lib/api/vendor-analytics.js';

export interface ReorderRateCardProps {
  readonly reorderRate: ReorderRate;
}

export function ReorderRateCard({ reorderRate }: ReorderRateCardProps): ReactNode {
  const { customerCount, repeatCustomerCount, rate } = reorderRate;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Reorder rate</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-moss-50 text-moss-700">
          <Repeat aria-hidden="true" className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-4 font-tabular text-3xl font-semibold tracking-tight text-slate-900">
        {customerCount === 0 ? '—' : formatPercent(rate)}
      </p>
      <p className="mt-2 text-xs text-slate-500">
        {customerCount === 0
          ? 'No delivered orders in this window yet.'
          : `${repeatCustomerCount.toString()} of ${customerCount.toString()} customers reordered`}
      </p>
    </div>
  );
}
