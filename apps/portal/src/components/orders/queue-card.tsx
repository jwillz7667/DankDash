import { Clock, Package, User } from 'lucide-react';
import { type ReactNode } from 'react';
import { type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { cn } from '../../lib/cn.js';
import {
  ageTone,
  formatMoney,
  formatRelativeTime,
  formatShortCode,
  type AgeTone,
} from '../../lib/orders/format.js';

export interface QueueCardProps {
  readonly order: VendorQueueOrderSummary;
  /**
   * "Now" reference used by the relative-time renderer. Injected so
   * the parent can synchronize the timestamp across every card in a
   * single board paint (otherwise each card would compute its own
   * `new Date()` and ages would drift by a few ms across renders).
   */
  readonly now: Date;
  /**
   * Fires when the operator taps the card. The parent opens the order
   * detail drawer (Phase 14.3). Omit on read-only contexts (no-op).
   */
  readonly onSelect?: (orderId: string) => void;
}

/**
 * Single order card. Renders the customer, short code, item count,
 * order age, and total. Action affordances (accept, transition,
 * drag-drop) land in Phase 14.2 / 14.3 — this commit ships the static
 * card so the board layout is reviewable end-to-end.
 *
 * Layout invariants:
 *   - Total is right-aligned with `font-tabular` so columns of $X.XX
 *     align even when amounts have different digit counts.
 *   - The wall-clock placedAt rides on `title` for screen-reader /
 *     hover precision; the visible label is the human-friendly
 *     relative time.
 */
export function QueueCard({ order, now, onSelect }: QueueCardProps): ReactNode {
  const ageLabel = formatRelativeTime(order.statusChangedAt, now);
  const tone = ageTone(order.statusChangedAt, now);
  const customerLabel = order.customerName ?? 'Guest customer';
  const itemLabel = order.itemCount === 1 ? '1 item' : `${order.itemCount.toString()} items`;
  const interactive = onSelect !== undefined;

  // We render the card as a `<button>` when interactive so it gets
  // keyboard (Enter/Space) + screen-reader semantics for free, and as
  // a plain `<article>` otherwise (Storybook, no-op contexts). Both
  // shapes preserve `data-testid` and `data-order-id` for the realtime
  // patching reducer's lookup paths.
  if (interactive) {
    return (
      <button
        type="button"
        onClick={(): void => {
          onSelect(order.id);
        }}
        className={cn(
          'w-full rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm',
          'transition-colors duration-150 hover:border-slate-300 hover:shadow-md',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50',
        )}
        data-testid="queue-card"
        data-order-id={order.id}
        data-age-tone={tone}
      >
        <CardContent
          order={order}
          customerLabel={customerLabel}
          itemLabel={itemLabel}
          ageLabel={ageLabel}
          tone={tone}
        />
      </button>
    );
  }

  return (
    <article
      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors duration-150 hover:border-slate-300 hover:shadow-md"
      data-testid="queue-card"
      data-order-id={order.id}
      data-age-tone={tone}
    >
      <CardContent
        order={order}
        customerLabel={customerLabel}
        itemLabel={itemLabel}
        ageLabel={ageLabel}
        tone={tone}
      />
    </article>
  );
}

interface CardContentProps {
  readonly order: VendorQueueOrderSummary;
  readonly customerLabel: string;
  readonly itemLabel: string;
  readonly ageLabel: string;
  readonly tone: AgeTone;
}

function CardContent({
  order,
  customerLabel,
  itemLabel,
  ageLabel,
  tone,
}: CardContentProps): ReactNode {
  return (
    <>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-semibold tracking-tight text-slate-900">
            {customerLabel}
          </p>
          <p className="font-tabular text-xs text-slate-500">{formatShortCode(order.shortCode)}</p>
        </div>
        <span className="font-tabular text-sm font-medium text-slate-900">
          {formatMoney(order.totalCents)}
        </span>
      </header>
      <dl className="mt-3 flex items-center gap-3 text-xs text-slate-500">
        <div className="flex items-center gap-1">
          <Package aria-hidden="true" className="h-3.5 w-3.5" />
          <dt className="sr-only">Item count</dt>
          <dd>{itemLabel}</dd>
        </div>
        <div
          className={cn('flex items-center gap-1 font-medium', AGE_TONE_TEXT[tone])}
          title={order.placedAt}
        >
          <Clock aria-hidden="true" className="h-3.5 w-3.5" />
          <dt className="sr-only">Time in current status</dt>
          <dd>{ageLabel}</dd>
        </div>
        <div className="ml-auto flex items-center gap-1 text-slate-400">
          <User aria-hidden="true" className="h-3.5 w-3.5" />
          <dt className="sr-only">Customer reference</dt>
          <dd className="font-tabular">{order.userId.slice(0, 6)}</dd>
        </div>
      </dl>
    </>
  );
}

/**
 * Tailwind classes for each escalation tone. Kept near the component
 * so a designer tweaking the palette doesn't have to chase the helper.
 * The "calm" tone leans on slate-500 (the default body text color)
 * rather than green, since a card under five minutes old isn't trying
 * to draw attention — it just isn't behind.
 */
const AGE_TONE_TEXT: Record<AgeTone, string> = {
  success: 'text-slate-500',
  warning: 'text-amber-700',
  danger: 'text-rose-700',
};
