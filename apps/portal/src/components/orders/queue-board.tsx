'use client';

/**
 * Client-side container that owns the queue's reactive state.
 *
 *   - Seeds local state from the server-fetched initial snapshot.
 *   - Re-buckets into columns on every state change.
 *   - Re-paints relative-time labels on a single shared `now` clock
 *     so every card's age stays in sync within a paint (tested in
 *     queue-board.test.tsx).
 *   - When `realtime` is supplied, opens a vendor-namespace Socket.io
 *     connection (via `useRealtimeOrders`) and patches the snapshot in
 *     place on `order:created` / `order:status_changed` events. The
 *     reducer is in `lib/orders/realtime-reducer.ts` so the merge logic
 *     is testable without React.
 *
 * Phase 14.3+ extends this with drag-drop transitions and the order
 * detail drawer; Phase 14.4 adds the polling fallback that activates
 * when the realtime status drops to `disconnected`/`error` for longer
 * than a grace window.
 */
import { Activity, Loader2, Plug, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  type TransitionResponse,
  type VendorQueueOrderSummary,
} from '../../lib/api/vendor-orders.js';
import { type VendorOrderActions } from '../../lib/orders/order-actions.js';
import { QUEUE_COLUMNS, bucketByColumn } from '../../lib/orders/queue-columns.js';
import { applyOrderCreated, applyOrderStatusChanged } from '../../lib/orders/realtime-reducer.js';
import { useRealtimeOrders, type UseRealtimeOrdersOptions } from '../../lib/realtime/hooks.js';
import { Badge, type BadgeProps } from '../ui/badge.js';
import { OrderDetailDrawer } from './order-detail-drawer.js';
import { QueueColumn } from './queue-column.js';
import type { RealtimeStatus } from '../../lib/realtime/client.js';

export interface QueueBoardRealtimeConfig {
  readonly url: string;
  readonly token: string;
  readonly dispensaryId?: string;
}

export interface QueueBoardProps {
  readonly initialOrders: readonly VendorQueueOrderSummary[];
  /**
   * Realtime connection coordinates. When omitted, the board renders
   * the seeded snapshot but never opens a socket — used by tests and
   * by the no-dispensary-context fallback page.
   */
  readonly realtime?: QueueBoardRealtimeConfig;
  /**
   * Vendor-orders surface the drawer uses to fetch the detail and fire
   * transition actions. When omitted, cards are not clickable and the
   * drawer is not rendered — tests for pure board behavior use this
   * shape; production always supplies the server-action implementation.
   */
  readonly actions?: VendorOrderActions;
  /**
   * Test seam — production omits this and the board uses the real
   * `Date.now()` clock. Tests pass a deterministic constructor so the
   * relative-time labels are stable across runs.
   */
  readonly nowFactory?: () => Date;
  /**
   * How often (ms) to recompute the relative-time labels. Defaults to
   * 60_000 — the smallest unit the human-friendly formatter emits past
   * 30 seconds is "Xm ago", so anything more granular is wasted paint.
   * Tests override to a smaller value when exercising the tick.
   */
  readonly tickIntervalMs?: number;
  /**
   * Test seam — production omits this and the realtime hook builds a
   * real `RealtimeClient`. Tests inject a fake so the board's reducer
   * integration can be driven end-to-end without socket.io.
   */
  readonly clientFactory?: UseRealtimeOrdersOptions['clientFactory'];
}

export function QueueBoard({
  initialOrders,
  realtime,
  actions,
  nowFactory,
  tickIntervalMs = 60_000,
  clientFactory,
}: QueueBoardProps): ReactNode {
  const now = useNow(nowFactory, tickIntervalMs);
  const [orders, setOrders] = useState<readonly VendorQueueOrderSummary[]>(() => initialOrders);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const handleCreated = useCallback((payload: Parameters<typeof applyOrderCreated>[1]) => {
    setOrders((prev) => applyOrderCreated(prev, payload));
  }, []);
  const handleStatusChanged = useCallback(
    (payload: Parameters<typeof applyOrderStatusChanged>[1]) => {
      setOrders((prev) => applyOrderStatusChanged(prev, payload));
    },
    [],
  );

  const { status } = useRealtimeOrders({
    url: realtime?.url ?? '',
    token: realtime?.token ?? '',
    ...(realtime?.dispensaryId !== undefined ? { dispensaryId: realtime.dispensaryId } : {}),
    enabled: realtime !== undefined,
    onCreated: handleCreated,
    onStatusChanged: handleStatusChanged,
    ...(clientFactory !== undefined ? { clientFactory } : {}),
  });

  const buckets = useMemo(() => bucketByColumn(orders), [orders]);

  // Translate the action's `TransitionResponse` into the same payload
  // shape the realtime channel emits, then run it through the same
  // reducer. That keeps a single mutation chokepoint regardless of
  // whether the change came from a button click or a websocket event.
  const handleTransition = useCallback((response: TransitionResponse): void => {
    setOrders((prev) =>
      applyOrderStatusChanged(prev, {
        orderId: response.id,
        customerId: '',
        dispensaryId: '',
        driverId: null,
        fromStatus: 'placed',
        toStatus: response.status,
        changedAt: response.statusChangedAt,
      }),
    );
  }, []);

  const handleSelect = useCallback((orderId: string): void => {
    setSelectedOrderId(orderId);
  }, []);
  const handleCloseDrawer = useCallback((): void => {
    setSelectedOrderId(null);
  }, []);

  const cardOnSelect = actions !== undefined ? handleSelect : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <RealtimeBadge status={status} enabled={realtime !== undefined} />
      </div>
      <div
        aria-label="Order queue"
        role="region"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        {QUEUE_COLUMNS.map((column) => (
          <QueueColumn
            key={column.key}
            column={column}
            orders={buckets[column.key]}
            now={now}
            {...(cardOnSelect !== undefined ? { onSelect: cardOnSelect } : {})}
          />
        ))}
      </div>
      {actions !== undefined && (
        <OrderDetailDrawer
          orderId={selectedOrderId}
          onClose={handleCloseDrawer}
          onTransition={handleTransition}
          actions={actions}
          now={now}
        />
      )}
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

interface RealtimeBadgeProps {
  readonly status: RealtimeStatus;
  readonly enabled: boolean;
}

interface RealtimeBadgeDisplay {
  readonly tone: NonNullable<BadgeProps['tone']>;
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint: string;
}

function RealtimeBadge({ status, enabled }: RealtimeBadgeProps): ReactNode {
  const display = describeRealtimeStatus(status, enabled);
  return (
    <Badge
      tone={display.tone}
      icon={display.icon}
      aria-label={display.hint}
      data-testid="realtime-status-badge"
      data-status={status}
      title={display.hint}
    >
      {display.label}
    </Badge>
  );
}

function describeRealtimeStatus(status: RealtimeStatus, enabled: boolean): RealtimeBadgeDisplay {
  if (!enabled) {
    return {
      tone: 'neutral',
      icon: <Plug aria-hidden="true" className="h-3 w-3" />,
      label: 'Offline',
      hint: 'Realtime is not configured for this session.',
    };
  }
  switch (status) {
    case 'connected':
      return {
        tone: 'success',
        icon: <Wifi aria-hidden="true" className="h-3 w-3" />,
        label: 'Live',
        hint: 'Realtime connected — new orders and status changes patch the board automatically.',
      };
    case 'connecting':
      return {
        tone: 'info',
        icon: <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />,
        label: 'Connecting',
        hint: 'Opening the realtime connection…',
      };
    case 'disconnected':
      return {
        tone: 'warning',
        icon: <WifiOff aria-hidden="true" className="h-3 w-3" />,
        label: 'Reconnecting',
        hint: 'Realtime dropped — reconnecting. The polling fallback will kick in if this persists.',
      };
    case 'error':
      return {
        tone: 'danger',
        icon: <WifiOff aria-hidden="true" className="h-3 w-3" />,
        label: 'Offline',
        hint: 'Realtime could not connect. Refresh the page or check your network.',
      };
    case 'idle':
    default:
      return {
        tone: 'neutral',
        icon: <Activity aria-hidden="true" className="h-3 w-3" />,
        label: 'Standby',
        hint: 'Realtime is paused — actions will trigger reconnect.',
      };
  }
}
