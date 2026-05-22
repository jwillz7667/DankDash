/**
 * The contract the drawer (and, in Phase 14.3, the drag-drop layer)
 * uses to talk to the vendor-orders surface. Factored out as an
 * interface so:
 *
 *   - Production wires the Next.js server actions in
 *     {@link import('./actions.js')} (which call `ApiClient` server-side).
 *   - Tests inject in-memory fakes — no Auth.js session, no Next.js
 *     runtime, no socket required.
 *
 * Every transition action resolves with the canonical
 * {@link TransitionResponse} so the queue board can patch its local
 * snapshot with the same `applyOrderStatusChanged` reducer that handles
 * realtime events. That keeps a single source of truth for "an order
 * changed status," regardless of whether the change came from the user
 * clicking a button or from the websocket.
 */
import type { TransitionResponse, VendorOrderDetail } from '../api/vendor-orders.js';

export interface VendorOrderActions {
  /**
   * Fetch the full {@link VendorOrderDetail} for the drawer. Called
   * when the operator opens an order; not cached — the drawer always
   * shows the freshest server-side projection on open.
   */
  readonly fetch: (orderId: string) => Promise<VendorOrderDetail>;
  /** `placed` → `accepted`. */
  readonly accept: (orderId: string) => Promise<TransitionResponse>;
  /** Any pre-prep state → `rejected`. Requires a reason (1–500 chars). */
  readonly reject: (orderId: string, reason: string) => Promise<TransitionResponse>;
  /** `accepted` → `prepping`. */
  readonly markPrepped: (orderId: string) => Promise<TransitionResponse>;
  /** `prepping` → `ready_for_pickup`. */
  readonly markReady: (orderId: string) => Promise<TransitionResponse>;
  /** `driver_assigned` → `picked_up` (vendor confirms handoff). */
  readonly markHandoff: (orderId: string) => Promise<TransitionResponse>;
}
