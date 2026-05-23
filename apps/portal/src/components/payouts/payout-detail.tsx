import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { formatMoney } from '../../lib/analytics/format.js';
import { type VendorPayoutDetail } from '../../lib/api/vendor-payouts.js';
import {
  formatCustomerShortName,
  formatPeriodRange,
  formatTimestamp,
  payoutStatusBadge,
} from '../../lib/payouts/format.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';

export interface PayoutDetailProps {
  readonly payout: VendorPayoutDetail;
}

/**
 * Server-renderable detail view for a single payout. Renders the
 * summary KPIs (gross / fees / net) + status / disbursement timestamps
 * + the constituent delivered orders that contributed to the window.
 *
 * The orders table reconciles the gross — the sum of `totalCents` will
 * equal `grossCents` minus any in-window refunds (the ledger nets those
 * out before the payout row is written). The footer prints the sum as
 * a sanity check the operator can eyeball.
 */
export function PayoutDetail({ payout }: PayoutDetailProps): ReactNode {
  const badge = payoutStatusBadge(payout.status);
  const ordersSubtotal = payout.orders.reduce((sum, o) => sum + o.totalCents, 0);

  return (
    <div className="flex flex-col gap-6" data-testid="payout-detail">
      <div className="flex items-center gap-2 text-sm text-muted">
        <Link
          href="/payouts"
          className="inline-flex items-center gap-1 hover:text-secondary hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          All payouts
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {formatPeriodRange(payout.periodStart, payout.periodEnd)}
          </h1>
          <p className="text-sm text-muted">
            {payout.aeropayPayoutRef !== null
              ? `Aeropay reference ${payout.aeropayPayoutRef}`
              : 'Awaiting Aeropay disbursement'}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${badge.className}`}
        >
          {badge.label}
        </span>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryStat label="Gross" valueCents={payout.grossCents} />
        <SummaryStat label="Fees" valueCents={-payout.feesCents} subtle={payout.feesCents === 0} />
        <SummaryStat label="Net deposit" valueCents={payout.netCents} highlight />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Disbursement</CardTitle>
            <CardSubtitle>
              When Aeropay was instructed and when funds landed in your account.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted">Scheduled</dt>
              <dd className="mt-1 font-medium text-secondary">{payout.scheduledFor}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted">Initiated</dt>
              <dd className="mt-1 font-medium text-secondary">
                {formatTimestamp(payout.initiatedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted">Completed</dt>
              <dd className="mt-1 font-medium text-secondary">
                {formatTimestamp(payout.completedAt)}
              </dd>
            </div>
          </dl>
          {payout.failureReason !== null && (
            <p
              role="alert"
              className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger ring-1 ring-inset ring-danger/30"
            >
              <span className="font-medium">Failure reason:</span> {payout.failureReason}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Constituent orders</CardTitle>
            <CardSubtitle>
              Delivered orders inside the period. Gross above reconciles to the sum here, less
              in-window refunds.
            </CardSubtitle>
          </div>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {payout.orders.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-muted">
              No orders delivered inside this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full divide-y divide-outline-subtle text-left text-sm">
                <thead className="bg-surface-muted text-xs font-medium uppercase tracking-wider text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3">
                      Order
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Customer
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Delivered
                    </th>
                    <th scope="col" className="px-4 py-3 text-right">
                      Subtotal
                    </th>
                    <th scope="col" className="px-4 py-3 text-right">
                      Discount
                    </th>
                    <th scope="col" className="px-4 py-3 text-right">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-subtle">
                  {payout.orders.map((order) => (
                    <tr key={order.id} className="hover:bg-surface-muted">
                      <td className="px-4 py-3 font-medium text-secondary">{order.shortCode}</td>
                      <td className="px-4 py-3 text-secondary">
                        {formatCustomerShortName(order.customerFirstName, order.customerLastName)}
                      </td>
                      <td className="px-4 py-3 text-muted">{formatTimestamp(order.deliveredAt)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-secondary">
                        {formatMoney(order.subtotalCents)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {order.discountCents === 0 ? '—' : `−${formatMoney(order.discountCents)}`}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                        {formatMoney(order.totalCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-outline bg-surface-muted">
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-3 text-right text-xs uppercase tracking-wider text-muted"
                    >
                      Sum of order totals
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                      {formatMoney(ordersSubtotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryStat({
  label,
  valueCents,
  highlight,
  subtle,
}: {
  readonly label: string;
  readonly valueCents: number;
  readonly highlight?: boolean;
  readonly subtle?: boolean;
}): ReactNode {
  return (
    <Card className={highlight === true ? 'ring-1 ring-moss-200' : undefined}>
      <CardBody className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        <p
          className={
            'text-2xl font-semibold tabular-nums ' +
            (highlight === true
              ? 'text-moss-700'
              : subtle === true
                ? 'text-muted'
                : 'text-foreground')
          }
        >
          {formatMoney(valueCents)}
        </p>
      </CardBody>
    </Card>
  );
}
