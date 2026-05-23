'use client';

import { useDraggable } from '@dnd-kit/core';
import { Clock, GripVertical, Package, User } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
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
   * detail drawer. Omit on read-only contexts (no-op).
   */
  readonly onSelect?: (orderId: string) => void;
  /**
   * When `true`, the card registers with the enclosing `DndContext` so
   * the operator can drag it to a sibling column. The hook is called
   * regardless — passing `disabled` to `useDraggable` keeps drag inert
   * when the order's status has no legal forward transition.
   *
   * Click-to-select still works while draggable is on: the
   * `PointerSensor` in the board uses an activation distance so a
   * quick click without movement falls through to `onSelect`.
   */
  readonly isDraggable?: boolean;
}

/**
 * Single order card. Renders the customer, short code, item count,
 * order age, and total. Three shapes:
 *
 *   - Plain article — Storybook / no-op contexts.
 *   - Button       — interactive (opens the drawer on click).
 *   - Draggable    — same as button but registered with `DndContext`
 *                    so the operator can drag the card to another
 *                    column. Drag and click coexist via the board's
 *                    pointer-activation distance.
 */
export function QueueCard({
  order,
  now,
  onSelect,
  isDraggable = false,
}: QueueCardProps): ReactNode {
  const ageLabel = formatRelativeTime(order.statusChangedAt, now);
  const tone = ageTone(order.statusChangedAt, now);
  const customerLabel = order.customerName ?? 'Guest customer';
  const itemLabel = order.itemCount === 1 ? '1 item' : `${order.itemCount.toString()} items`;
  const interactive = onSelect !== undefined;

  const draggable = useDraggable({
    id: order.id,
    disabled: !isDraggable,
  });

  const dragStyle: CSSProperties =
    draggable.transform !== null
      ? {
          transform: `translate3d(${draggable.transform.x.toString()}px, ${draggable.transform.y.toString()}px, 0)`,
          // While dragging, the original card stays in place but is dimmed
          // so the operator's eye follows the overlay preview instead.
          opacity: draggable.isDragging ? 0.4 : 1,
          zIndex: draggable.isDragging ? 50 : undefined,
        }
      : {};

  if (interactive) {
    return (
      <button
        ref={draggable.setNodeRef}
        type="button"
        onClick={(): void => {
          onSelect(order.id);
        }}
        className={cn(
          'group relative w-full rounded-xl border border-outline bg-surface p-3 text-left shadow-sm',
          'transition-colors duration-150 hover:border-outline-strong hover:shadow-md',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted',
          isDraggable && 'cursor-grab touch-none active:cursor-grabbing',
          draggable.isDragging && 'shadow-lg',
        )}
        style={dragStyle}
        data-testid="queue-card"
        data-order-id={order.id}
        data-age-tone={tone}
        data-draggable={isDraggable ? 'true' : 'false'}
        data-dragging={draggable.isDragging ? 'true' : undefined}
        {...draggable.listeners}
        {...draggable.attributes}
      >
        {isDraggable && (
          <GripVertical
            aria-hidden="true"
            className="absolute right-2 top-2 h-3.5 w-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
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
      className="rounded-xl border border-outline bg-surface p-3 shadow-sm transition-colors duration-150 hover:border-outline-strong hover:shadow-md"
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
          <p className="truncate text-sm font-semibold tracking-tight text-foreground">
            {customerLabel}
          </p>
          <p className="font-tabular text-xs text-muted">{formatShortCode(order.shortCode)}</p>
        </div>
        <span className="font-tabular text-sm font-medium text-foreground">
          {formatMoney(order.totalCents)}
        </span>
      </header>
      <dl className="mt-3 flex items-center gap-3 text-xs text-muted">
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
        <div className="ml-auto flex items-center gap-1 text-muted">
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
 * The "calm" tone leans on `text-muted` (the default body text color)
 * rather than green, since a card under five minutes old isn't trying
 * to draw attention — it just isn't behind.
 */
const AGE_TONE_TEXT: Record<AgeTone, string> = {
  success: 'text-muted',
  warning: 'text-warning',
  danger: 'text-danger',
};
