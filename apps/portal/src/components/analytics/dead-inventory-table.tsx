/**
 * Dead-inventory table — listings with stock on hand but no deliveries
 * inside the window. Sorted by days-since-last-sale desc (the API
 * returns the rows already ordered). The portal renders this read-only;
 * follow-up phases will offer "discount" / "deactivate" actions inline,
 * but the v1 cut keeps the surface advisory so dispensaries make the
 * call themselves.
 */
import { type ReactNode } from 'react';
import { formatDaysSinceLastSale, formatMoney } from '../../lib/analytics/format.js';
import { type DeadInventoryRow } from '../../lib/api/vendor-analytics.js';

export interface DeadInventoryTableProps {
  readonly rows: readonly DeadInventoryRow[];
}

export function DeadInventoryTable({ rows }: DeadInventoryTableProps): ReactNode {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
        Nothing's gathering dust — every active listing sold in this window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="dead-inventory-table">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Listings with stock on hand that did not sell in the window
        </caption>
        <thead className="border-b border-slate-100 bg-slate-50/50 text-2xs font-medium uppercase tracking-wider text-slate-500">
          <tr>
            <th scope="col" className="py-3 pl-4 pr-3">
              Product
            </th>
            <th scope="col" className="px-3 py-3">
              SKU
            </th>
            <th scope="col" className="px-3 py-3 text-right">
              On hand
            </th>
            <th scope="col" className="px-3 py-3 text-right">
              Price
            </th>
            <th scope="col" className="pl-3 pr-4 py-3 text-right">
              Last sale
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.listingId}
              className="border-b border-slate-50 last:border-b-0 hover:bg-slate-50/50"
            >
              <td className="py-3 pl-4 pr-3">
                <p className="font-medium text-slate-900">{row.name}</p>
                <p className="text-xs text-slate-500">{row.brand}</p>
              </td>
              <td className="px-3 py-3 font-mono text-xs text-slate-500">{row.sku}</td>
              <td className="px-3 py-3 text-right font-tabular text-slate-700">
                {row.quantityAvailable.toString()}
              </td>
              <td className="px-3 py-3 text-right font-tabular text-slate-700">
                {formatMoney(row.priceCents)}
              </td>
              <td className="pl-3 pr-4 py-3 text-right font-tabular text-slate-500">
                {formatDaysSinceLastSale(row.daysSinceLastSale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
