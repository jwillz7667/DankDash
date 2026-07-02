import { Banknote } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { formatMoney } from '../../lib/analytics/format.js';
import { type PayoutSnapshot } from '../../lib/dashboard/dashboard.js';
import { formatPeriodDate, payoutStatusBadge } from '../../lib/payouts/format.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';

export interface PayoutSnapshotCardProps {
  readonly snapshot: PayoutSnapshot;
}

/**
 * Payout snapshot (manager+ only — sourced from `/v1/vendor/payouts`).
 * Shows the last deposit that landed and the next one scheduled, each a
 * net figure with its settlement/period date. Links into `/payouts` for
 * the full ledger. Degrades to an empty prompt before the first payout
 * settles.
 */
export function PayoutSnapshotCard({ snapshot }: PayoutSnapshotCardProps): ReactNode {
  const { last, next } = snapshot;
  const lastBadge = last === null ? null : payoutStatusBadge(last.status);

  return (
    <Card data-testid="payout-snapshot-card">
      <CardHeader>
        <div className="space-y-0.5">
          <CardTitle>Payouts</CardTitle>
          <CardSubtitle>Your latest and upcoming deposits.</CardSubtitle>
        </div>
        <Link href="/payouts" className="text-xs font-medium text-moss-700 hover:text-moss-800">
          View all
        </Link>
      </CardHeader>
      <CardBody className="space-y-4">
        {last === null && next === null ? (
          <div
            role="status"
            className="flex flex-col items-center gap-1.5 py-6 text-center"
            data-testid="payout-snapshot-empty"
          >
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-subtle text-muted"
            >
              <Banknote className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-secondary">No payouts yet</p>
            <p className="max-w-xs text-sm text-muted">
              Your first next-day deposit appears here once a delivered order settles.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-1" data-testid="payout-last">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted">
                Last deposit
              </p>
              {last === null ? (
                <p className="text-sm text-muted">None yet</p>
              ) : (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-tabular text-lg font-semibold text-foreground">
                    {formatMoney(last.netCents)}
                  </span>
                  <span className="text-xs text-muted">
                    {lastBadge?.label} · {formatPeriodDate(last.periodStart)}
                  </span>
                </div>
              )}
            </div>
            <div
              className="space-y-1 border-t border-outline-subtle pt-4"
              data-testid="payout-next"
            >
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted">
                Next scheduled
              </p>
              {next === null ? (
                <p className="text-sm text-muted">Nothing scheduled</p>
              ) : (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-tabular text-lg font-semibold text-foreground">
                    {formatMoney(next.netCents)}
                  </span>
                  <span className="text-xs text-muted">
                    {payoutStatusBadge(next.status).label} · {formatPeriodDate(next.scheduledFor)}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
