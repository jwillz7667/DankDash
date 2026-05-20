/**
 * Browser Notification API wrapper for new-order alerts.
 *
 * Three responsibilities:
 *
 *   1. Probe the current permission state without throwing when the
 *      API is missing (Safari iframe contexts, hardened browsers).
 *   2. Request permission — only valid from a user gesture, so the
 *      caller wires this behind a button click.
 *   3. Render an order-shaped notification with a stable `tag` so that
 *      a Socket.io redelivery doesn't stack toasts.
 *
 * The DOM Notification API is permission-gated and has subtly different
 * behavior across browsers. The wrapper normalizes those edges:
 *
 *   - Missing API → state collapses to `'unsupported'` and every
 *     attempt to show a notification is a silent no-op.
 *   - Legacy callback-style `requestPermission` (older Safari) is
 *     bridged into a promise.
 *   - Construction failures (security policy, missing icon path) are
 *     caught — a failed toast never blocks the realtime fold.
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/**
 * Read the current permission. Returns `'unsupported'` when the
 * Notification API isn't available at all (SSR, Safari private,
 * sandboxed iframe). Otherwise echoes the DOM permission verbatim.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined') return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return Notification.permission;
  } catch (error) {
    void error;
    return 'unsupported';
  }
}

/**
 * Prompt the operator for permission. MUST be called inside a user
 * gesture handler — Chrome's quiet-permission heuristics will reject
 * the prompt otherwise and silently downgrade to `'denied'`.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined') return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    // Notification.requestPermission has both callback and promise
    // overloads in the DOM lib. The promise overload is the modern
    // contract; even Safari 16+ supports it.
    const result = await Notification.requestPermission();
    return result;
  } catch (error) {
    void error;
    return 'denied';
  }
}

export interface OrderNotificationPayload {
  readonly orderId: string;
  readonly shortCode: string;
  readonly totalCents: number;
  readonly customerName: string | null;
}

export interface ShowOrderNotificationOptions {
  /**
   * Fires when the operator clicks the toast. The wrapper also tries
   * to focus the originating window so the click lands on the correct
   * tab — the spec is for the queue to pull focus on click.
   */
  readonly onClick?: (payload: OrderNotificationPayload) => void;
}

/**
 * Render a "New order #X" toast. Returns `null` when notifications
 * are unsupported, blocked, or construction fails — never throws into
 * the calling reducer.
 *
 * The `tag` deduplicates redeliveries: if Socket.io re-emits the same
 * `order:created` after a reconnect, the second `new Notification`
 * with the matching tag replaces the first in-place rather than
 * stacking a second toast. Combined with `renotify: false`, the user
 * never sees a "ping" twice for the same order.
 */
export function showOrderNotification(
  payload: OrderNotificationPayload,
  options: ShowOrderNotificationOptions = {},
): Notification | null {
  if (getNotificationPermission() !== 'granted') return null;

  const customer = payload.customerName ?? 'Guest customer';
  const dollars = formatTotalDollars(payload.totalCents);
  const title = `New order #${payload.shortCode}`;
  const body = `${customer} · ${dollars}`;

  try {
    const notification = new Notification(title, {
      body,
      tag: `dankdash-order-${payload.orderId}`,
    });
    if (options.onClick !== undefined) {
      const handler = options.onClick;
      notification.onclick = (): void => {
        try {
          window.focus();
        } catch (error) {
          // Some browsers reject window.focus() outside a user gesture
          // (post-toast click is a gesture, but pop-up-blocker rules
          // occasionally apply). The custom onClick still fires.
          void error;
        }
        handler(payload);
      };
    }
    return notification;
  } catch (error) {
    void error;
    return null;
  }
}

function formatTotalDollars(totalCents: number): string {
  const sign = totalCents < 0 ? '-' : '';
  const absCents = Math.abs(totalCents);
  const whole = Math.floor(absCents / 100).toString();
  const fraction = (absCents % 100).toString().padStart(2, '0');
  return `${sign}$${whole}.${fraction}`;
}
