'use client';

/**
 * Client-side container that owns the queue's reactive state.
 *
 * Phase 14.1 (this commit): receives the server-fetched initial
 * snapshot as a prop, buckets it into columns, and re-buckets on a
 * single shared `now` clock that ticks once a minute so every card's
 * relative-age label stays fresh without thrashing.
 *
 * Phase 14.2+ will layer in:
 *   - realtime `order:created` / `order:status_changed` patching of
 *     the local snapshot,
 *   - drag-drop transitions (forward-only) via the orders REST API,
 *   - audio chime + browser notification on `order:created`,
 *   - polling fallback when the socket disconnects.
 *
 * Keeping the board a client component now means each follow-up
 * phase only has to extend the local reducer, not rewire the page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ReactNode } from 'react';
import { type VendorQueueOrderSummary } from '../../lib/api/vendor-orders.js';
import { QUEUE_COLUMNS, bucketByColumn } from '../../lib/orders/queue-columns.js';
import { QueueColumn } from './queue-column.js';

export interface QueueBoardProps {
  readonly initialOrders: readonly VendorQueueOrderSummary[];
  /**
   * Test seam — production omits this and the board uses the real
   * `Date.now()` clock. Tests pass a deterministic constructor so the
   * relative-time labels are stable across runs.
   */
  readonly nowFactory?: () => Date;
  /**
   * How often (ms) to recompute the relative-time labels. Defaults to
   * 60_000 — the smallest unit the human-friendly formatter emits
   * past 30 seconds is "Xm ago", so anything more granular is wasted
   * paint. Tests override to a smaller value when exercising the
   * tick behavior.
   */
  readonly tickIntervalMs?: number;
}

export function QueueBoard({
  initialOrders,
  nowFactory,
  tickIntervalMs = 60_000,
}: QueueBoardProps): ReactNode {
  const now = useNow(nowFactory, tickIntervalMs);
  const buckets = useMemo(() => bucketByColumn(initialOrders), [initialOrders]);

  return (
    <div
      aria-label="Order queue"
      role="region"
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
    >
      {QUEUE_COLUMNS.map((column) => (
        <QueueColumn key={column.key} column={column} orders={buckets[column.key]} now={now} />
      ))}
    </div>
  );
}

/**
 * A shared "now" clock that ticks on the supplied interval. Returning
 * a single Date keeps every card in sync — each one's age delta is
 * computed off the same reference, so visual ordering by age stays
 * stable across paints.
 *
 * The factory is wrapped in a `useCallback` keyed off the prop so a
 * parent that re-renders with the same factory reference does not
 * reinstall the interval — re-running the timer on every parent paint
 * would defeat the rate-limit.
 */
function useNow(factory: (() => Date) | undefined, intervalMs: number): Date {
  const make = useCallback((): Date => (factory ?? ((): Date => new Date()))(), [factory]);
  const [now, setNow] = useState<Date>(() => make());

  useEffect(() => {
    if (intervalMs <= 0) return;
    const handle = setInterval(() => {
      setNow(make());
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [intervalMs, make]);

  return now;
}
