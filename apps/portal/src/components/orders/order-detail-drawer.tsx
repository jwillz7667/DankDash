'use client';

/**
 * Right-side slide-in drawer that paints the full order detail and
 * exposes the vendor's transition actions for the currently selected
 * order.
 *
 * State machine (per render):
 *
 *   - `orderId === null`         → not mounted (parent passes null to close)
 *   - `orderId` present, loading → spinner; backdrop click + ESC close
 *   - `orderId` present, loaded  → full UI; actions enabled per `status`
 *   - `orderId` present, error   → inline error with retry
 *
 * The drawer fires an `onTransition(TransitionResponse)` callback after
 * a successful action so the parent (QueueBoard) can fold the result
 * onto its local snapshot using the same `applyOrderStatusChanged`
 * reducer it uses for realtime events. Keeping that path in the parent
 * means there is exactly one place where the queue mutates state.
 *
 * Accessibility:
 *
 *   - `role="dialog"` with `aria-modal="true"` and an `aria-labelledby`
 *     pointing at the short-code heading.
 *   - ESC dismisses.
 *   - The backdrop is a focusable button so screen-readers announce it.
 *
 * Visual layering:
 *
 *   - Backdrop at `z-40` (covers the page but not the chrome shell).
 *   - Panel at `z-50` (above the backdrop, slides from `translate-x-full`
 *     to `0` via tailwind `transition-transform`).
 */
import { AlertTriangle, Ban, Check, ChefHat, Loader2, PackageCheck, Truck, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  type OrderStatus,
  type TransitionResponse,
  type VendorOrderDetail,
} from '../../lib/api/vendor-orders.js';
import { cn } from '../../lib/cn.js';
import { formatMoney, formatRelativeTime } from '../../lib/orders/format.js';
import { type VendorOrderActions } from '../../lib/orders/order-actions.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import { Button } from '../ui/button.js';

export interface OrderDetailDrawerProps {
  readonly orderId: string | null;
  readonly onClose: () => void;
  readonly onTransition: (payload: TransitionResponse) => void;
  readonly actions: VendorOrderActions;
  readonly now?: Date;
}

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly detail: VendorOrderDetail }
  | { readonly kind: 'error'; readonly message: string };

type ActionKey = 'accept' | 'reject' | 'markPrepped' | 'markReady' | 'markHandoff';

export function OrderDetailDrawer({
  orderId,
  onClose,
  onTransition,
  actions,
  now,
}: OrderDetailDrawerProps): ReactNode {
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [pending, setPending] = useState<ActionKey | null>(null);
  const [rejectOpen, setRejectOpen] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [actionError, setActionError] = useState<string | null>(null);

  // Keep the active order id in a ref-free closure: we re-fetch
  // whenever the prop changes. Cancellation is via an `aborted` flag so
  // a rapid open → open(different id) doesn't race the responses.
  useEffect(() => {
    if (orderId === null) {
      setLoad({ kind: 'idle' });
      setRejectOpen(false);
      setRejectReason('');
      setActionError(null);
      setPending(null);
      return;
    }

    let aborted = false;
    setLoad({ kind: 'loading' });
    setRejectOpen(false);
    setRejectReason('');
    setActionError(null);
    setPending(null);

    actions
      .fetch(orderId)
      .then((detail) => {
        if (aborted) return;
        setLoad({ kind: 'loaded', detail });
      })
      .catch((error: unknown) => {
        if (aborted) return;
        setLoad({ kind: 'error', message: extractMessage(error) });
      });

    return () => {
      aborted = true;
    };
  }, [orderId, actions]);

  // ESC dismisses, but only while the drawer is mounted. We attach to
  // `window` because a backdrop-only handler misses keys pressed when
  // focus is inside the panel (e.g. on the textarea).
  useEffect(() => {
    if (orderId === null) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [orderId, onClose]);

  const runAction = useCallback(
    async (key: ActionKey, fn: () => Promise<TransitionResponse>): Promise<void> => {
      setPending(key);
      setActionError(null);
      try {
        const result = await fn();
        onTransition(result);
        // Reflect the new status locally — the panel may stay open
        // until the operator closes it (e.g., to immediately mark the
        // next step). Patching `detail.status` here matches the
        // optimistic-replay shape the queue board does on the same
        // event.
        setLoad((prev) =>
          prev.kind === 'loaded'
            ? {
                kind: 'loaded',
                detail: {
                  ...prev.detail,
                  status: result.status,
                  statusChangedAt: result.statusChangedAt,
                },
              }
            : prev,
        );
        setRejectOpen(false);
        setRejectReason('');
      } catch (error) {
        setActionError(extractMessage(error));
      } finally {
        setPending(null);
      }
    },
    [onTransition],
  );

  if (orderId === null) return null;

  return (
    <div className="fixed inset-0 z-40" data-testid="order-detail-drawer-root">
      <button
        type="button"
        className="absolute inset-0 bg-surface-inverse/40 backdrop-blur-sm"
        aria-label="Close order detail"
        onClick={onClose}
        data-testid="order-detail-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-detail-title"
        data-testid="order-detail-drawer"
        className={cn(
          'absolute right-0 top-0 flex h-full w-full max-w-md flex-col',
          'border-l border-outline bg-surface shadow-2xl',
        )}
      >
        <DrawerHeader load={load} onClose={onClose} />
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {load.kind === 'loading' && (
            <div className="flex flex-1 items-center justify-center py-12">
              <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-muted" />
              <span className="sr-only">Loading order…</span>
            </div>
          )}
          {load.kind === 'error' && (
            <DrawerErrorState
              message={load.message}
              onRetry={(): void => {
                setLoad({ kind: 'loading' });
                actions
                  .fetch(orderId)
                  .then((detail) => {
                    setLoad({ kind: 'loaded', detail });
                  })
                  .catch((error: unknown) => {
                    setLoad({ kind: 'error', message: extractMessage(error) });
                  });
              }}
            />
          )}
          {load.kind === 'loaded' && <DrawerBody detail={load.detail} now={now ?? new Date()} />}
        </div>
        {load.kind === 'loaded' && (
          <DrawerFooter
            detail={load.detail}
            pending={pending}
            rejectOpen={rejectOpen}
            rejectReason={rejectReason}
            actionError={actionError}
            onRejectOpen={(): void => {
              setRejectOpen(true);
              setActionError(null);
            }}
            onRejectCancel={(): void => {
              setRejectOpen(false);
              setRejectReason('');
            }}
            onRejectReasonChange={setRejectReason}
            onAccept={(): Promise<void> =>
              runAction('accept', () => actions.accept(load.detail.id))
            }
            onMarkPrepped={(): Promise<void> =>
              runAction('markPrepped', () => actions.markPrepped(load.detail.id))
            }
            onMarkReady={(): Promise<void> =>
              runAction('markReady', () => actions.markReady(load.detail.id))
            }
            onMarkHandoff={(): Promise<void> =>
              runAction('markHandoff', () => actions.markHandoff(load.detail.id))
            }
            onRejectSubmit={(): Promise<void> =>
              runAction('reject', () => actions.reject(load.detail.id, rejectReason.trim()))
            }
          />
        )}
      </div>
    </div>
  );
}

function DrawerHeader({
  load,
  onClose,
}: {
  readonly load: LoadState;
  readonly onClose: () => void;
}): ReactNode {
  const title = load.kind === 'loaded' ? `#${load.detail.shortCode}` : 'Order';
  const status = load.kind === 'loaded' ? load.detail.status : null;
  return (
    <header className="flex items-start justify-between gap-3 border-b border-outline px-6 py-4">
      <div className="min-w-0 space-y-1">
        <h2
          id="order-detail-title"
          className="font-tabular text-lg font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        {status !== null && (
          <Badge tone={STATUS_BADGE_TONE[status]} data-testid="order-detail-status">
            {STATUS_LABEL[status]}
          </Badge>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="-mt-1 flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-subtle hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500"
        data-testid="order-detail-close"
      >
        <X aria-hidden="true" className="h-5 w-5" />
      </button>
    </header>
  );
}

function DrawerBody({
  detail,
  now,
}: {
  readonly detail: VendorOrderDetail;
  readonly now: Date;
}): ReactNode {
  return (
    <div className="space-y-6 text-sm">
      <MoneyBreakdown detail={detail} />
      <Timeline detail={detail} now={now} />
    </div>
  );
}

function MoneyBreakdown({ detail }: { readonly detail: VendorOrderDetail }): ReactNode {
  return (
    <section aria-label="Order totals" className="space-y-2">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted">Totals</h3>
      <dl className="divide-y divide-outline-subtle rounded-xl border border-outline bg-surface-muted/40">
        <Line label="Subtotal" cents={detail.subtotalCents} />
        <Line label="Cannabis tax" cents={detail.cannabisTaxCents} />
        <Line label="Sales tax" cents={detail.salesTaxCents} />
        <Line label="Delivery fee" cents={detail.deliveryFeeCents} />
        <Line label="Driver tip" cents={detail.driverTipCents} />
        {detail.discountCents > 0 && <Line label="Discount" cents={-detail.discountCents} />}
        <Line label="Total" cents={detail.totalCents} emphasized />
      </dl>
    </section>
  );
}

function Line({
  label,
  cents,
  emphasized,
}: {
  readonly label: string;
  readonly cents: number;
  readonly emphasized?: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-2.5',
        emphasized && 'bg-surface font-semibold text-foreground',
      )}
    >
      <dt className={cn('text-secondary', emphasized && 'text-foreground')}>{label}</dt>
      <dd className="font-tabular text-foreground">{formatMoney(cents)}</dd>
    </div>
  );
}

function Timeline({
  detail,
  now,
}: {
  readonly detail: VendorOrderDetail;
  readonly now: Date;
}): ReactNode {
  const entries = TIMELINE_FIELDS.flatMap(({ key, label }) => {
    const at = detail.timestamps[key];
    return at === null ? [] : [{ key, label, at }];
  });
  return (
    <section aria-label="Order timeline" className="space-y-2">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted">Timeline</h3>
      <ol className="space-y-1.5 rounded-xl border border-outline bg-surface p-4">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center justify-between text-sm">
            <span className="text-secondary">{entry.label}</span>
            <span className="font-tabular text-muted" title={entry.at}>
              {formatRelativeTime(entry.at, now)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DrawerErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle aria-hidden="true" className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">Couldn't load the order</p>
      <p className="text-xs text-muted">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry} data-testid="order-detail-retry">
        Try again
      </Button>
    </div>
  );
}

interface DrawerFooterProps {
  readonly detail: VendorOrderDetail;
  readonly pending: ActionKey | null;
  readonly rejectOpen: boolean;
  readonly rejectReason: string;
  readonly actionError: string | null;
  readonly onAccept: () => Promise<void> | void;
  readonly onMarkPrepped: () => Promise<void> | void;
  readonly onMarkReady: () => Promise<void> | void;
  readonly onMarkHandoff: () => Promise<void> | void;
  readonly onRejectOpen: () => void;
  readonly onRejectCancel: () => void;
  readonly onRejectReasonChange: (next: string) => void;
  readonly onRejectSubmit: () => Promise<void> | void;
}

function DrawerFooter({
  detail,
  pending,
  rejectOpen,
  rejectReason,
  actionError,
  onAccept,
  onMarkPrepped,
  onMarkReady,
  onMarkHandoff,
  onRejectOpen,
  onRejectCancel,
  onRejectReasonChange,
  onRejectSubmit,
}: DrawerFooterProps): ReactNode {
  const trimmedLength = rejectReason.trim().length;
  const rejectReasonValid = trimmedLength >= 1 && trimmedLength <= 500;
  const acceptable = AVAILABLE_ACTIONS[detail.status];
  if (acceptable.length === 0 && !rejectOpen) {
    return null;
  }
  return (
    <footer className="border-t border-outline bg-surface-muted/40 px-6 py-4">
      {actionError !== null && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
          data-testid="order-detail-action-error"
        >
          {actionError}
        </p>
      )}
      {rejectOpen ? (
        <div className="space-y-3">
          <label
            htmlFor="order-detail-reject-reason"
            className="block text-xs font-semibold uppercase tracking-wider text-secondary"
          >
            Reason for rejection
          </label>
          <textarea
            id="order-detail-reject-reason"
            data-testid="order-detail-reject-reason"
            value={rejectReason}
            onChange={(event): void => {
              onRejectReasonChange(event.target.value);
            }}
            rows={3}
            maxLength={500}
            placeholder="e.g. Out of stock on the requested SKU"
            className="w-full rounded-lg border border-outline bg-surface p-3 text-sm text-foreground shadow-sm focus:border-moss-500 focus:outline-none focus:ring-2 focus:ring-moss-100"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onRejectCancel} disabled={pending !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={(): void => {
                void onRejectSubmit();
              }}
              disabled={!rejectReasonValid || pending !== null}
              data-testid="order-detail-reject-submit"
            >
              <Ban aria-hidden="true" className="h-4 w-4" />
              {pending === 'reject' ? 'Rejecting…' : 'Reject order'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {acceptable.map((action) => (
            <ActionButton
              key={action}
              action={action}
              pending={pending}
              onAccept={onAccept}
              onMarkPrepped={onMarkPrepped}
              onMarkReady={onMarkReady}
              onMarkHandoff={onMarkHandoff}
              onRejectOpen={onRejectOpen}
            />
          ))}
        </div>
      )}
    </footer>
  );
}

interface ActionButtonProps {
  readonly action: ActionKey;
  readonly pending: ActionKey | null;
  readonly onAccept: () => Promise<void> | void;
  readonly onMarkPrepped: () => Promise<void> | void;
  readonly onMarkReady: () => Promise<void> | void;
  readonly onMarkHandoff: () => Promise<void> | void;
  readonly onRejectOpen: () => void;
}

function ActionButton({
  action,
  pending,
  onAccept,
  onMarkPrepped,
  onMarkReady,
  onMarkHandoff,
  onRejectOpen,
}: ActionButtonProps): ReactNode {
  const isPending = pending === action;
  const disabled = pending !== null;
  switch (action) {
    case 'accept':
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={(): void => {
            void onAccept();
          }}
          disabled={disabled}
          data-testid="order-detail-action-accept"
        >
          <Check aria-hidden="true" className="h-4 w-4" />
          {isPending ? 'Accepting…' : 'Accept'}
        </Button>
      );
    case 'reject':
      return (
        <Button
          variant="danger"
          size="sm"
          onClick={onRejectOpen}
          disabled={disabled}
          data-testid="order-detail-action-reject"
        >
          <Ban aria-hidden="true" className="h-4 w-4" />
          Reject
        </Button>
      );
    case 'markPrepped':
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={(): void => {
            void onMarkPrepped();
          }}
          disabled={disabled}
          data-testid="order-detail-action-prepped"
        >
          <ChefHat aria-hidden="true" className="h-4 w-4" />
          {isPending ? 'Starting…' : 'Start prepping'}
        </Button>
      );
    case 'markReady':
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={(): void => {
            void onMarkReady();
          }}
          disabled={disabled}
          data-testid="order-detail-action-ready"
        >
          <PackageCheck aria-hidden="true" className="h-4 w-4" />
          {isPending ? 'Marking…' : 'Mark ready'}
        </Button>
      );
    case 'markHandoff':
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={(): void => {
            void onMarkHandoff();
          }}
          disabled={disabled}
          data-testid="order-detail-action-handoff"
        >
          <Truck aria-hidden="true" className="h-4 w-4" />
          {isPending ? 'Confirming…' : 'Confirm handoff'}
        </Button>
      );
  }
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

const TIMELINE_FIELDS: ReadonlyArray<{
  readonly key: keyof VendorOrderDetail['timestamps'];
  readonly label: string;
}> = [
  { key: 'placedAt', label: 'Placed' },
  { key: 'paymentFailedAt', label: 'Payment failed' },
  { key: 'acceptedAt', label: 'Accepted' },
  { key: 'rejectedAt', label: 'Rejected' },
  { key: 'preppingAt', label: 'Prepping' },
  { key: 'preparedAt', label: 'Prepared' },
  { key: 'awaitingDriverAt', label: 'Awaiting driver' },
  { key: 'dispatchFailedAt', label: 'Dispatch failed' },
  { key: 'driverAssignedAt', label: 'Driver assigned' },
  { key: 'enRoutePickupAt', label: 'Driver en route' },
  { key: 'pickedUpAt', label: 'Picked up' },
  { key: 'enRouteDropoffAt', label: 'En route to customer' },
  { key: 'arrivedAtDropoffAt', label: 'Arrived at customer' },
  { key: 'idScanPendingAt', label: 'ID scan pending' },
  { key: 'deliveredAt', label: 'Delivered' },
  { key: 'returnedToStoreAt', label: 'Returned to store' },
  { key: 'canceledAt', label: 'Canceled' },
  { key: 'disputedAt', label: 'Disputed' },
  { key: 'ratedAt', label: 'Rated' },
];

/**
 * Which actions are valid from each status. Mirrors the server-side
 * state machine — `placed` accepts or rejects, `accepted` starts
 * prepping or rejects, and so on. States that exist on the queue
 * surface but have no vendor-side action (waiting on dispatch or
 * driver) deliberately map to an empty array; the drawer renders no
 * footer for them.
 */
const AVAILABLE_ACTIONS: Readonly<Record<OrderStatus, readonly ActionKey[]>> = {
  placed: ['accept', 'reject'],
  payment_failed: [],
  accepted: ['markPrepped', 'reject'],
  rejected: [],
  prepping: ['markReady'],
  ready_for_pickup: [],
  awaiting_driver: [],
  dispatch_failed: [],
  driver_assigned: ['markHandoff'],
  en_route_pickup: [],
  picked_up: [],
  en_route_dropoff: [],
  arrived_at_dropoff: [],
  id_scan_pending: [],
  id_scan_passed: [],
  id_scan_failed: [],
  delivered: [],
  returned_to_store: [],
  canceled: [],
  disputed: [],
};

const STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  placed: 'Placed',
  payment_failed: 'Payment failed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  prepping: 'Prepping',
  ready_for_pickup: 'Ready for pickup',
  awaiting_driver: 'Awaiting driver',
  dispatch_failed: 'Dispatch failed',
  driver_assigned: 'Driver assigned',
  en_route_pickup: 'Driver en route',
  picked_up: 'Picked up',
  en_route_dropoff: 'En route to customer',
  arrived_at_dropoff: 'Arrived at customer',
  id_scan_pending: 'ID scan pending',
  id_scan_passed: 'ID scan passed',
  id_scan_failed: 'ID scan failed',
  delivered: 'Delivered',
  returned_to_store: 'Returned to store',
  canceled: 'Canceled',
  disputed: 'Disputed',
};

const STATUS_BADGE_TONE: Readonly<Record<OrderStatus, BadgeTone>> = {
  placed: 'info',
  payment_failed: 'danger',
  accepted: 'accent',
  rejected: 'danger',
  prepping: 'accent',
  ready_for_pickup: 'warning',
  awaiting_driver: 'warning',
  dispatch_failed: 'danger',
  driver_assigned: 'success',
  en_route_pickup: 'success',
  picked_up: 'success',
  en_route_dropoff: 'success',
  arrived_at_dropoff: 'success',
  id_scan_pending: 'warning',
  id_scan_passed: 'success',
  id_scan_failed: 'danger',
  delivered: 'success',
  returned_to_store: 'neutral',
  canceled: 'neutral',
  disputed: 'danger',
};
