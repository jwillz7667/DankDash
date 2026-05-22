/**
 * Socket.io span + gauge instrumentation.
 *
 * The Phase 21 spec calls for queue / connection visibility. The
 * `@opentelemetry/instrumentation-socket.io` autoinstrumentation that
 * `@dankdash/observability` registers handles per-emit / per-on spans;
 * what it does NOT do is publish the long-lived "how many sockets are
 * currently connected" gauge that Grafana's realtime-overview
 * dashboard needs. This module fills that gap.
 *
 * Surface:
 *
 *   - `realtime_active_connections{namespace}` — gauge, +1 on
 *     namespace `connection`, -1 on `disconnect`. Labels by namespace
 *     so /customer, /vendor (Phase 19), /driver (Phase 21) are
 *     attributable.
 *   - `realtime_connections_total{namespace,outcome}` — counter.
 *     `outcome=opened` on connect; `outcome=closed` on disconnect.
 *     The pair gives both a rate (`outcome=opened`) and a disconnect
 *     rate that the alert rule fires on.
 *   - `realtime_emit_total{namespace,event}` — counter incremented
 *     for every server-to-client emit on a namespace. Phase 21 uses
 *     this to back the "emit rate" panel; the autoinstrumentation
 *     spans give the latency.
 *
 * Bounded cardinality:
 *   The `event` label could be unbounded in principle, but the
 *   realtime service has a closed set of emit names defined in
 *   `apps/realtime/src/bus/order-events-bus.ts` + the namespace
 *   files. We assert that closed set at attach time so a careless
 *   `socket.emit('user-typed-' + sessionId, ...)` (high-cardinality)
 *   never lands in the registry. Out-of-set events are tagged
 *   `event=other` instead of leaking their literal name.
 */
import { Counter, Gauge, type Registry } from 'prom-client';
import type { Namespace, Server } from 'socket.io';

const KNOWN_EMIT_EVENTS = new Set<string>([
  // From order-events-bus.ts
  'order:status_changed',
  // Phase 19+ — declared now so the cardinality contract is stable.
  'driver:assigned',
  'driver:location',
  'eta:updated',
  // Generic error envelope sent on auth/role failure.
  'error',
]);

export interface SocketSpansHandle {
  /** Detach all listeners. Used in tests and at shutdown. */
  detach(): void;
  readonly activeConnections: Gauge;
  readonly connectionsTotal: Counter;
  readonly emitsTotal: Counter;
}

export interface SocketSpansOptions {
  readonly io: Server;
  readonly registry: Registry;
  /**
   * Namespaces to attach to. Defaults to `['/customer']` — the only
   * namespace registered in Phase 18. Phase 19+ adds `/driver` and
   * `/vendor`; callers extend the list when those land.
   */
  readonly namespaces?: readonly string[];
}

export function attachSocketSpans(options: SocketSpansOptions): SocketSpansHandle {
  const namespaces = options.namespaces ?? ['/customer'];
  const activeConnections = new Gauge({
    name: 'realtime_active_connections',
    help: 'Active Socket.io connections, labelled by namespace.',
    labelNames: ['namespace'],
    registers: [options.registry],
  });
  const connectionsTotal = new Counter({
    name: 'realtime_connections_total',
    help: 'Lifetime Socket.io connection events; `outcome` is opened|closed.',
    labelNames: ['namespace', 'outcome'],
    registers: [options.registry],
  });
  const emitsTotal = new Counter({
    name: 'realtime_emit_total',
    help: 'Server-to-client Socket.io emits, labelled by namespace and event.',
    labelNames: ['namespace', 'event'],
    registers: [options.registry],
  });

  const cleanups: Array<() => void> = [];

  for (const path of namespaces) {
    const nsp = options.io.of(path);
    activeConnections.labels({ namespace: path }).set(0);

    const onConnection = (socket: { on: (e: string, fn: () => void) => void }): void => {
      activeConnections.inc({ namespace: path });
      connectionsTotal.inc({ namespace: path, outcome: 'opened' });
      socket.on('disconnect', () => {
        activeConnections.dec({ namespace: path });
        connectionsTotal.inc({ namespace: path, outcome: 'closed' });
      });
    };
    nsp.on('connection', onConnection);
    cleanups.push(() => nsp.off('connection', onConnection));

    // Patch the namespace emit so every fan-out increments the counter.
    // We patch at the namespace level (rather than per-socket) because
    // the order-events-bus emits via `io.of('/customer').to(room).emit`,
    // which routes through the namespace prototype.
    const originalEmit: Namespace['emit'] = nsp.emit.bind(nsp);
    const patchedEmit: Namespace['emit'] = ((event: string | symbol, ...args: unknown[]) => {
      const eventName = typeof event === 'string' ? event : String(event);
      const label = KNOWN_EMIT_EVENTS.has(eventName) ? eventName : 'other';
      emitsTotal.inc({ namespace: path, event: label });
      return originalEmit(event as Parameters<Namespace['emit']>[0], ...args);
    }) as Namespace['emit'];
    nsp.emit = patchedEmit;
    cleanups.push(() => {
      nsp.emit = originalEmit;
    });
  }

  return {
    activeConnections,
    connectionsTotal,
    emitsTotal,
    detach() {
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn !== undefined) fn();
      }
    },
  };
}
