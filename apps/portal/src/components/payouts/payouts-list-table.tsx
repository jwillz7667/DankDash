import Link from 'next/link';
import { type ReactNode } from 'react';
import { formatMoney } from '../../lib/analytics/format.js';
import { type VendorPayoutSummary } from '../../lib/api/vendor-payouts.js';
import { formatPeriodRange, formatTimestamp, payoutStatusBadge } from '../../lib/payouts/format.js';

export interface PayoutsListTableProps {
  readonly payouts: readonly VendorPayoutSummary[];
}

/**
 * Pure, server-renderable table of payout summaries. The page renders
 * it directly off the API response — there is no client interactivity
 * beyond row links to the detail page.
 *
 * Empty state is in-table so the CTA aligns under the column header
 * when there are zero rows; same pattern as MenuTable's empty state.
 */
export function PayoutsListTable({ payouts }: PayoutsListTableProps): ReactNode {
  if (payouts.length === 0) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center"
      >
        <p className="text-sm font-medium text-slate-700">No payouts yet</p>
        <p className="max-w-md text-sm text-slate-500">
          Once your first delivered order settles overnight, the next-day payout will appear here
          with the gross, fees, and final net deposit.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full divide-y divide-slate-100 text-left text-sm">
        <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wider text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3">
              Period
            </th>
            <th scope="col" className="px-4 py-3">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right">
              Gross
            </th>
            <th scope="col" className="px-4 py-3 text-right">
              Fees
            </th>
            <th scope="col" className="px-4 py-3 text-right">
              Net
            </th>
            <th scope="col" className="px-4 py-3">
              Disbursed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {payouts.map((payout) => (
            <PayoutsListRow key={payout.id} payout={payout} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayoutsListRow({ payout }: { readonly payout: VendorPayoutSummary }): ReactNode {
  const badge = payoutStatusBadge(payout.status);
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-3">
        <Link
          href={`/payouts/${payout.id}`}
          className="font-medium text-slate-900 underline-offset-4 hover:underline"
        >
          {formatPeriodRange(payout.periodStart, payout.periodEnd)}
        </Link>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badge.className}`}
        >
          {badge.label}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
        {formatMoney(payout.grossCents)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-500">
        {payout.feesCents === 0 ? '—' : `−${formatMoney(payout.feesCents)}`}
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
        {formatMoney(payout.netCents)}
      </td>
      <td className="px-4 py-3 text-slate-500">
        {payout.completedAt === null ? '—' : formatTimestamp(payout.completedAt)}
      </td>
    </tr>
  );
}
