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
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Activity, AlertCircle, Loader2, Plug, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  asOrderStatus,
  type OrderStatus,
  type TransitionResponse,
  type VendorQueueOrderSummary,
} from '../../lib/api/vendor-orders.js';
import { useOrderAlert, type UseOrderAlertOptions } from '../../lib/notifications/hooks.js';
import { type VendorOrderActions } from '../../lib/orders/order-actions.js';
import {
  QUEUE_COLUMNS,
  bucketByColumn,
  columnKeyForStatus,
} from '../../lib/orders/queue-columns.js';
import {
  dispatchDragAction,
  resolveDragDrop,
  validTargetColumnsFor,
} from '../../lib/orders/queue-dnd.js';
import { applyOrderCreated, applyOrderStatusChanged } from '../../lib/orders/realtime-reducer.js';
import { mergePolledSnapshot } from '../../lib/orders/snapshot-merge.js';
import { useRealtimeOrders, type UseRealtimeOrdersOptions } from '../../lib/realtime/hooks.js';
import { useQueueSnapshotPolling } from '../../lib/realtime/polling-fallback.js';
import { Badge, type BadgeProps } from '../ui/badge.js';
import { NotificationControls } from './notification-controls.js';
import { OrderDetailDrawer } from './order-detail-drawer.js';
import { QueueCard } from './queue-card.js';
import { QueueColumn } from './queue-column.js';
import type { OrderSummary, RealtimeStatus } from '../../lib/realtime/client.js';

const ALL_DRAGGABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'placed',
  'prepping',
]);

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
  /**
   * Drag activation distance in pixels (default 6). Below this the
   * pointer event is treated as a click and falls through to the
   * card's `onSelect`. Tests override to 0 so synthetic pointer
   * events don't need to simulate a real drag distance.
   */
  readonly dragActivationDistance?: number;
  /**
   * Test seam — production omits and the chime + permission hook
   * builds its own player. Tests pass a fake `ChimePlayer` plus
   * options to drive `useOrderAlert` deterministically.
   */
  readonly alertOptions?: UseOrderAlertOptions;
  /**
   * Polling fallback (Phase 14.4). When the realtime socket drops to
   * `disconnected`/`error` past the grace window, this fetcher is
   * called every {@link pollIntervalMs} to re-seed the snapshot from
   * the REST endpoint. When omitted, the fallback is disabled — used
   * by tests and by the no-dispensary-context fallback page.
   */
  readonly pollFetcher?: () => Promise<{ readonly orders: readonly VendorQueueOrderSummary[] }>;
  /** Polling interval in ms. Defaults to 15_000 per Phase 14.4 spec. */
  readonly pollIntervalMs?: number;
  /**
   * Grace window before the first poll fires after a WS drop. Defaults
   * to 10_000 — short enough that a real outage gets a snapshot inside
   * one polling cycle, long enough to ride out a brief reconnect.
   */
  readonly pollGracePeriodMs?: number;
}

export function QueueBoard({
  initialOrders,
  realtime,
  actions,
  nowFactory,
  tickIntervalMs = 60_000,
  clientFactory,
  dragActivationDistance = 6,
  alertOptions,
  pollFetcher,
  pollIntervalMs,
  pollGracePeriodMs,
}: QueueBoardProps): ReactNode {
  const now = useNow(nowFactory, tickIntervalMs);
  const [orders, setOrders] = useState<readonly VendorQueueOrderSummary[]>(() => initialOrders);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [draggingOrderId, setDraggingOrderId] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);

  const alert = useOrderAlert(alertOptions ?? {});

  // The chime + browser notification fire from inside the same realtime
  // reducer that mutates the snapshot. Keeping the side effect at the
  // boundary (rather than in a `useEffect` that watches `orders`) is
  // the single mutation chokepoint principle applied to alerts —
  // exactly one place where a new-order event becomes a sensory cue.
  const handleCreated = useCallback(
    (payload: OrderSummary) => {
      // Filter alerts to *queue-visible* statuses. The server may emit
      // `order:created` for an order that's already past the queue
      // surface (rare — payment-failed pre-paint, instant Metrc revoke),
      // and we don't want to chime for an order the operator will
      // never see on the board.
      const status = asOrderStatus(payload.status);
      if (status !== null && columnKeyForStatus(status) !== undefined) {
        alert.trigger({
          orderId: payload.orderId,
          shortCode: payload.shortCode,
          totalCents: payload.totalCents,
          customerName: null,
        });
      }
      setOrders((prev) => applyOrderCreated(prev, payload));
    },
    [alert],
  );
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

  // Polling fallback kicks in when the socket has been down past the
  // grace window. We re-seed the snapshot from the same projection
  // the server-component page loader uses; the merge preserves row
  // identity for unchanged rows so React's reconciliation stays cheap.
  const handlePolledSnapshot = useCallback(
    (snapshot: { readonly orders: readonly VendorQueueOrderSummary[] }): void => {
      setOrders((prev) => mergePolledSnapshot(prev, snapshot.orders));
    },
    [],
  );
  const pollingEnabled =
    pollFetcher !== undefined &&
    realtime !== undefined &&
    (status === 'disconnected' || status === 'error');
  const polling = useQueueSnapshotPolling<{ readonly orders: readonly VendorQueueOrderSummary[] }>({
    enabled: pollingEnabled,
    fetcher: pollFetcher ?? noopPollFetcher,
    onSnapshot: handlePolledSnapshot,
    ...(pollIntervalMs !== undefined ? { intervalMs: pollIntervalMs } : {}),
    ...(pollGracePeriodMs !== undefined ? { gracePeriodMs: pollGracePeriodMs } : {}),
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

  const handleDragStart = useCallback((event: DragStartEvent): void => {
    setDragError(null);
    setDraggingOrderId(String(event.active.id));
  }, []);
  const handleDragCancel = useCallback((_event: DragCancelEvent): void => {
    setDraggingOrderId(null);
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setDraggingOrderId(null);
      if (actions === undefined) return;

      const resolved = resolveDragDrop(orders, event.active.id, event.over?.id);
      if (resolved === null) return;

      // Fire-and-forget: the reducer fold runs inside the awaited
      // promise so a transient failure surfaces an inline error, but
      // we don't block the drag interaction itself.
      void (async (): Promise<void> => {
        try {
          const response = await dispatchDragAction(resolved, actions);
          handleTransition(response);
        } catch (error) {
          setDragError(extractMessage(error));
        }
      })();
    },
    [orders, actions, handleTransition],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: dragActivationDistance } }),
    useSensor(KeyboardSensor),
  );

  const draggingOrder = useMemo(
    () =>
      draggingOrderId !== null ? (orders.find((o) => o.id === draggingOrderId) ?? null) : null,
    [draggingOrderId, orders],
  );
  const validTargets = useMemo(
    () => (draggingOrder !== null ? validTargetColumnsFor(draggingOrder.status) : null),
    [draggingOrder],
  );

  const cardOnSelect = actions !== undefined ? handleSelect : undefined;
  const dragEnabled = actions !== undefined;
  const draggableStatuses = dragEnabled ? ALL_DRAGGABLE_STATUSES : undefined;

  const board = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        {dragError !== null ? (
          <DragErrorBanner
            message={dragError}
            onDismiss={(): void => {
              setDragError(null);
            }}
          />
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="flex items-center gap-3">
          <NotificationControls
            isMuted={alert.isMuted}
            onToggleMuted={alert.toggleMuted}
            permission={alert.permission}
            onRequestPermission={(): void => {
              void alert.requestPermission();
            }}
            onUserGesture={alert.primeFromGesture}
          />
          <RealtimeBadge
            status={status}
            enabled={realtime !== undefined}
            polling={polling.active}
            lastPolledAt={polling.lastPolledAt}
          />
        </div>
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
            {...(draggableStatuses !== undefined ? { draggableStatuses } : {})}
            droppableEnabled={dragEnabled}
            isValidDropTarget={validTargets?.has(column.key) === true}
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

  if (!dragEnabled) {
    return board;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {board}
      <DragOverlay dropAnimation={null}>
        {draggingOrder !== null ? (
          <div className="pointer-events-none" data-testid="drag-overlay">
            <QueueCard order={draggingOrder} now={now} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The transition could not be completed.';
}

interface DragErrorBannerProps {
  readonly message: string;
  readonly onDismiss: () => void;
}

function DragErrorBanner({ message, onDismiss }: DragErrorBannerProps): ReactNode {
  return (
    <div
      role="alert"
      data-testid="drag-error-banner"
      className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="font-semibold text-danger hover:text-danger"
      >
        Dismiss
      </button>
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
  readonly polling: boolean;
  readonly lastPolledAt: Date | null;
}

interface RealtimeBadgeDisplay {
  readonly tone: NonNullable<BadgeProps['tone']>;
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint: string;
  readonly dataMode: 'idle' | 'live' | 'connecting' | 'reconnecting' | 'polling' | 'offline';
}

function RealtimeBadge({ status, enabled, polling, lastPolledAt }: RealtimeBadgeProps): ReactNode {
  const display = describeRealtimeStatus(status, enabled, polling, lastPolledAt);
  return (
    <Badge
      tone={display.tone}
      icon={display.icon}
      aria-label={display.hint}
      data-testid="realtime-status-badge"
      data-status={status}
      data-mode={display.dataMode}
      title={display.hint}
    >
      {display.label}
    </Badge>
  );
}

function describeRealtimeStatus(
  status: RealtimeStatus,
  enabled: boolean,
  polling: boolean,
  lastPolledAt: Date | null,
): RealtimeBadgeDisplay {
  if (!enabled) {
    return {
      tone: 'neutral',
      icon: <Plug aria-hidden="true" className="h-3 w-3" />,
      label: 'Offline',
      hint: 'Realtime is not configured for this session.',
      dataMode: 'offline',
    };
  }
  // Polling supersedes the underlying socket status label — when the
  // fallback is actively delivering snapshots, the operator should
  // see "Polling" not "Reconnecting". The data is still flowing,
  // just over a different channel.
  if (polling) {
    const ts = lastPolledAt !== null ? ` Last sync ${lastPolledAt.toLocaleTimeString()}.` : '';
    return {
      tone: 'warning',
      icon: <RefreshCw aria-hidden="true" className="h-3 w-3 animate-spin" />,
      label: 'Polling',
      hint: `Realtime is down — pulling the queue on a 15s interval until it reconnects.${ts}`,
      dataMode: 'polling',
    };
  }
  switch (status) {
    case 'connected':
      return {
        tone: 'success',
        icon: <Wifi aria-hidden="true" className="h-3 w-3" />,
        label: 'Live',
        hint: 'Realtime connected — new orders and status changes patch the board automatically.',
        dataMode: 'live',
      };
    case 'connecting':
      return {
        tone: 'info',
        icon: <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />,
        label: 'Connecting',
        hint: 'Opening the realtime connection…',
        dataMode: 'connecting',
      };
    case 'disconnected':
      return {
        tone: 'warning',
        icon: <WifiOff aria-hidden="true" className="h-3 w-3" />,
        label: 'Reconnecting',
        hint: 'Realtime dropped — reconnecting. The polling fallback will kick in if this persists.',
        dataMode: 'reconnecting',
      };
    case 'error':
      return {
        tone: 'danger',
        icon: <WifiOff aria-hidden="true" className="h-3 w-3" />,
        label: 'Offline',
        hint: 'Realtime could not connect. Refresh the page or check your network.',
        dataMode: 'offline',
      };
    case 'idle':
    default:
      return {
        tone: 'neutral',
        icon: <Activity aria-hidden="true" className="h-3 w-3" />,
        label: 'Standby',
        hint: 'Realtime is paused — actions will trigger reconnect.',
        dataMode: 'idle',
      };
  }
}

/**
 * Placeholder fetcher injected when no `pollFetcher` prop is provided.
 * `useQueueSnapshotPolling` guards every fire on `enabled`, which is
 * always false in that case — this function exists only to satisfy
 * the hook's non-optional `fetcher` field at type level.
 */
function noopPollFetcher(): Promise<{ readonly orders: readonly VendorQueueOrderSummary[] }> {
  return Promise.resolve({ orders: [] });
}
