'use client';

import { useDroppable } from '@dnd-kit/core';
import { type ReactNode } from 'react';
import { type OrderStatus, type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { cn } from '../../lib/cn.js';
import { type QueueColumnConfig, type QueueColumnKey } from '../../lib/orders/queue-columns.js';
import { Badge } from '../ui/badge.js';
import { QueueCard } from './queue-card.js';

export interface QueueColumnProps {
  readonly column: QueueColumnConfig;
  readonly orders: readonly VendorQueueOrderSummary[];
  readonly now: Date;
  /**
   * Fires when the operator selects a card. Forwarded verbatim to each
   * `QueueCard` so the board can centralize the drawer state without
   * the column knowing about the drawer at all.
   */
  readonly onSelect?: (orderId: string) => void;
  /**
   * Per-status drag-eligibility. The column passes
   * `draggableStatuses.has(order.status)` to each card so the column
   * doesn't have to know the legal-forward-transition rules itself —
   * the board owns that mapping.
   */
  readonly draggableStatuses?: ReadonlySet<OrderStatus>;
  /**
   * When `true`, the column registers as a `DndContext` droppable. The
   * board sets this for columns that accept *any* forward drop from
   * the currently-dragging card. Columns without a legal drop are
   * still rendered, but their droppable is inert so `onDragEnd` won't
   * resolve them as a target.
   */
  readonly droppableEnabled?: boolean;
  /**
   * Whether the in-flight drag, if any, will be accepted by this
   * column. Drives the dashed-border highlight. Computed by the board
   * from `validTargetColumnsFor(draggingOrder.status)`.
   */
  readonly isValidDropTarget?: boolean;
}

/**
 * Single kanban column. Renders a sticky header (label + count badge
 * + helper subtitle) and a scrollable card list. Empty columns render
 * a single muted line so the four-up layout doesn't collapse when one
 * lane is quiet — keeps spatial muscle memory intact for the operator.
 *
 * Wraps the card list in a `useDroppable` so the board's `DndContext`
 * can resolve drag-drop transitions to a column. The column key is
 * the droppable id — the board's `onDragEnd` decodes it back into a
 * `QueueColumnKey` via the `QUEUE_COLUMNS` table.
 */
export function QueueColumn({
  column,
  orders,
  now,
  onSelect,
  draggableStatuses,
  droppableEnabled = false,
  isValidDropTarget = false,
}: QueueColumnProps): ReactNode {
  const droppable = useDroppable({
    id: column.key,
    disabled: !droppableEnabled,
  });
  const isActiveDropTarget = droppable.isOver && isValidDropTarget;

  return (
    <section
      aria-label={`${column.label} column`}
      className="flex h-full flex-col rounded-2xl border border-outline bg-surface-muted/50"
      data-column-key={column.key}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-outline px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{column.label}</h3>
            <Badge tone={column.tone} aria-label={`${orders.length.toString()} orders`}>
              {orders.length}
            </Badge>
          </div>
          <p className="text-xs text-muted">{column.helper}</p>
        </div>
      </header>
      <div
        ref={droppable.setNodeRef}
        className={cn(
          'flex flex-1 flex-col gap-2 overflow-y-auto rounded-b-2xl p-3 transition-colors',
          isValidDropTarget && 'bg-moss-50/40',
          isActiveDropTarget && 'bg-moss-100/60 ring-2 ring-inset ring-moss-400',
        )}
        data-column-droppable={column.key}
        data-drop-target={isValidDropTarget ? 'true' : 'false'}
        data-drop-active={isActiveDropTarget ? 'true' : undefined}
      >
        {orders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline bg-surface px-3 py-6 text-center text-xs text-muted">
            No orders.
          </p>
        ) : (
          orders.map((order) => (
            <QueueCard
              key={order.id}
              order={order}
              now={now}
              {...(onSelect !== undefined ? { onSelect } : {})}
              isDraggable={draggableStatuses?.has(order.status) === true}
            />
          ))
        )}
      </div>
    </section>
  );
}

export type { QueueColumnKey };
