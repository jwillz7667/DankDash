/**
 * Top-products list. Renders the API's `topProducts` array — already
 * sorted by revenue desc — as a vertical leaderboard with a thin
 * inline bar that visually compares the row's revenue against the
 * leader. Pure server component; no interactivity.
 */
import { type ReactNode } from 'react';
import { formatMoney } from '../../lib/analytics/format.js';
import { type TopProduct } from '../../lib/api/vendor-analytics.js';

export interface TopProductsListProps {
  readonly products: readonly TopProduct[];
  /** Optional cap when the API returns more rows than the surface needs. */
  readonly limit?: number;
}

export function TopProductsList({ products, limit }: TopProductsListProps): ReactNode {
  const rows = limit !== undefined ? products.slice(0, limit) : products;

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
        No sales in this window yet.
      </p>
    );
  }

  const max = rows[0]?.revenueCents ?? 0;

  return (
    <ol className="flex flex-col gap-3" data-testid="top-products-list">
      {rows.map((product, index) => {
        const pct = max === 0 ? 0 : (product.revenueCents / max) * 100;
        return (
          <li key={product.productId} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  <span className="mr-2 inline-block w-4 text-2xs font-semibold text-slate-400">
                    {(index + 1).toString()}.
                  </span>
                  {product.brand} — {product.name}
                </p>
                <p className="ml-6 text-xs text-slate-500">
                  {product.unitsSold.toString()} unit{product.unitsSold === 1 ? '' : 's'}
                </p>
              </div>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                {formatMoney(product.revenueCents)}
              </p>
            </div>
            <div
              aria-hidden="true"
              className="ml-6 h-1.5 overflow-hidden rounded-full bg-slate-100"
            >
              <div
                className="h-full rounded-full bg-moss-500"
                style={{ width: `${pct.toFixed(1)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
