/**
 * Socket.io client wrapper for the vendor portal.
 *
 *   - Connects to the realtime service's `/vendor` namespace.
 *   - Auth via the JWT in the handshake (`auth.token`) — same shape the
 *     iOS and driver clients use, so the realtime service has one
 *     verification path.
 *   - Auto-reconnect with exponential backoff is provided by the
 *     underlying `socket.io-client`; we tune the cap to 30s so a long
 *     server outage doesn't make the portal cold-start a slow connect.
 *   - Typed event subscription: callers register handlers keyed off the
 *     realtime-events union (`order:created`, `order:status_changed`,
 *     etc.) and receive strongly-typed payloads.
 *
 * Production consumers should prefer the `useRealtimeOrders` hook from
 * `./hooks.ts` rather than constructing a client directly — the hook
 * owns React lifecycle, cleanup, and the polling fallback.
 *
 * This module is framework-free so it can be imported by tests without
 * pulling in React.
 */
import { DomainError, type ErrorDetails } from '@dankdash/types';
import { io, type Socket } from 'socket.io-client';

/**
 * Programmer-error guard. Raised when callers invoke `on()` before
 * `connect()` — the type-system can't enforce that ordering through
 * an idiomatic React effect, so the runtime check is the safety net.
 * Extends DomainError to satisfy the workspace lint rule that forbids
 * raw `throw new Error(...)`. The constructor exists to widen the
 * parent's `protected` ctor to `public` so callers in this module can
 * instantiate it.
 */
class RealtimeUsageError extends DomainError {
  public readonly code = 'REALTIME_USAGE_ERROR';
  public readonly statusCode = 500;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

/**
 * Loose shape we cast `Socket` to at the typed-event boundary.
 * Socket.io's `on`/`off` overload narrows the listener via a
 * conditional on the *literal* event name; when our generic `E` is
 * `RealtimeEventName` rather than a literal, the conditional collapses
 * to a signature TS rejects our variadic wrapper against. The runtime
 * delegates straight to EventEmitter, so the cast is purely a
 * type-level relaxation.
 */
interface LooseEventTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface OrderSummary {
  readonly orderId: string;
  readonly customerId: string;
  readonly dispensaryId: string;
  readonly shortCode: string;
  readonly totalCents: number;
  readonly status: string;
  readonly placedAt: string;
}

export interface OrderStatusChange {
  readonly orderId: string;
  readonly customerId: string;
  readonly dispensaryId: string;
  readonly driverId: string | null;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly changedAt: string;
}

/**
 * Live driver GPS for an in-progress delivery. The realtime service fans
 * this to the fulfilling dispensary's vendor room (alongside the
 * customer) so the per-order map can animate the driver marker.
 * `orderId` is non-null on the vendor leg (the order being delivered);
 * consumers filter by it since one socket sees every active delivery for
 * the dispensary.
 */
export interface DriverLocation {
  readonly driverId: string;
  readonly orderId: string | null;
  readonly customerId: string | null;
  readonly dispensaryId: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyMeters: number | null;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  readonly recordedAt: string;
}

/**
 * Map of server-side event names to their typed payloads. New events
 * added here must be mirrored on the realtime service's vendor
 * namespace; the portal otherwise silently drops them.
 */
export interface RealtimeEventMap {
  'order:created': OrderSummary;
  'order:status_changed': OrderStatusChange;
  'driver:location': DriverLocation;
}

export type RealtimeEventName = keyof RealtimeEventMap;

export type RealtimeEventHandler<E extends RealtimeEventName> = (
  payload: RealtimeEventMap[E],
) => void;

export type StatusListener = (status: RealtimeStatus) => void;

export interface RealtimeClientOptions {
  readonly url: string;
  readonly token: string;
  readonly dispensaryId?: string;
  /**
   * Test seam — production injects nothing; tests inject a stub that
   * matches the `io()` factory shape so we never reach a real socket.
   */
  readonly socketFactory?: typeof io;
  /**
   * Cap on the reconnect-delay backoff (ms). Defaults to 30s — long
   * enough that a tab parked overnight isn't hammering on resume,
   * short enough that an operator actively watching their console
   * sees the reconnect happen.
   */
  readonly reconnectionDelayMax?: number;
}

export class RealtimeClient {
  private socket: Socket | null = null;
  private status: RealtimeStatus = 'idle';
  private readonly statusListeners = new Set<StatusListener>();
  private readonly options: Readonly<Omit<RealtimeClientOptions, 'socketFactory'>>;
  private readonly factory: typeof io;
  private readonly disposers = new Map<string, Set<() => void>>();

  constructor(options: RealtimeClientOptions) {
    const { socketFactory, ...rest } = options;
    this.options = rest;
    this.factory = socketFactory ?? io;
  }

  /**
   * Open the socket. Idempotent — calling twice does not reconnect.
   * Use `disconnect()` first if a re-handshake with a new token is
   * required.
   */
  connect(): void {
    if (this.socket !== null) return;
    this.setStatus('connecting');

    const socket = this.factory(`${this.options.url}/vendor`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: this.options.reconnectionDelayMax ?? 30_000,
      timeout: 10_000,
      auth: {
        token: this.options.token,
        ...(this.options.dispensaryId !== undefined
          ? { dispensaryId: this.options.dispensaryId }
          : {}),
      },
    });

    socket.on('connect', () => {
      this.setStatus('connected');
    });
    socket.on('disconnect', () => {
      this.setStatus('disconnected');
    });
    socket.on('connect_error', () => {
      this.setStatus('error');
    });

    this.socket = socket;
  }

  disconnect(): void {
    const socket = this.socket;
    if (socket === null) return;
    socket.removeAllListeners();
    socket.disconnect();
    this.socket = null;
    this.disposers.clear();
    this.setStatus('idle');
  }

  /**
   * Subscribe to a typed event. Returns the disposer; callers MUST
   * call it from cleanup paths (`useEffect` return value, etc.) or
   * handlers leak across renders.
   */
  on<E extends RealtimeEventName>(event: E, handler: RealtimeEventHandler<E>): () => void {
    if (this.socket === null) {
      throw new RealtimeUsageError('RealtimeClient.on called before connect()');
    }
    const loose = this.socket as unknown as LooseEventTarget;
    const listener = (...args: unknown[]): void => {
      handler(args[0] as RealtimeEventMap[E]);
    };
    loose.on(event, listener);

    const disposer = (): void => {
      loose.off(event, listener);
      const set = this.disposers.get(event);
      if (set) {
        set.delete(disposer);
        if (set.size === 0) this.disposers.delete(event);
      }
    };
    let set = this.disposers.get(event);
    if (!set) {
      set = new Set();
      this.disposers.set(event, set);
    }
    set.add(disposer);
    return disposer;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status); // fire immediately for new subscribers
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) {
      listener(next);
    }
  }
}
