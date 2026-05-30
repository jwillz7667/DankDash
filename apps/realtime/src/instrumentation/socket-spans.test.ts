/**
 * Unit tests for the socket-spans instrumentation.
 *
 * The module patches a Socket.io namespace's connection/disconnect
 * lifecycle + its `emit` to populate Prom gauges/counters. These
 * tests use a fake `Server`/`Namespace`/`Socket` so we exercise the
 * wiring without spinning up the full Fastify + Socket.io stack
 * (which is covered by `server.test.ts`).
 */
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { attachSocketSpans } from './socket-spans.js';

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  private readonly handlers = new Map<string, Listener>();
  on(event: string, fn: Listener): void {
    this.handlers.set(event, fn);
  }
  emit(event: string, ...args: unknown[]): boolean {
    const fn = this.handlers.get(event);
    if (fn !== undefined) fn(...args);
    return true;
  }
  disconnect(): void {
    this.emit('disconnect');
  }
}

class FakeNamespace {
  private readonly connectionHandlers = new Set<(socket: FakeSocket) => void>();
  emit(_event: string | symbol, ..._args: unknown[]): boolean {
    return true;
  }
  on(_event: 'connection', fn: (socket: FakeSocket) => void): void {
    this.connectionHandlers.add(fn);
  }
  off(_event: 'connection', fn: (socket: FakeSocket) => void): void {
    this.connectionHandlers.delete(fn);
  }
  connect(socket: FakeSocket): void {
    for (const fn of this.connectionHandlers) fn(socket);
  }
}

class FakeServer {
  private readonly namespaces = new Map<string, FakeNamespace>();
  of(path: string): FakeNamespace {
    const existing = this.namespaces.get(path);
    if (existing !== undefined) return existing;
    const fresh = new FakeNamespace();
    this.namespaces.set(path, fresh);
    return fresh;
  }
}

async function readMetric(registry: Registry, name: string): Promise<string> {
  const text = await registry.metrics();
  const lines = text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith('#'));
  return lines.join('\n');
}

describe('attachSocketSpans', () => {
  it('increments active connections on connect and decrements on disconnect', async () => {
    const registry = new Registry();
    const io = new FakeServer();
    attachSocketSpans({
      io: io as unknown as Parameters<typeof attachSocketSpans>[0]['io'],
      registry,
      namespaces: ['/customer'],
    });

    const nsp = io.of('/customer');
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    nsp.connect(s1);
    nsp.connect(s2);
    expect(await readMetric(registry, 'realtime_active_connections')).toContain(
      'realtime_active_connections{namespace="/customer"} 2',
    );

    s1.disconnect();
    expect(await readMetric(registry, 'realtime_active_connections')).toContain(
      'realtime_active_connections{namespace="/customer"} 1',
    );

    s2.disconnect();
    expect(await readMetric(registry, 'realtime_active_connections')).toContain(
      'realtime_active_connections{namespace="/customer"} 0',
    );
  });

  it('tags known emit events by name and unknown emits as "other"', async () => {
    const registry = new Registry();
    const io = new FakeServer();
    attachSocketSpans({
      io: io as unknown as Parameters<typeof attachSocketSpans>[0]['io'],
      registry,
      namespaces: ['/customer'],
    });

    const nsp = io.of('/customer');
    nsp.emit('order:status_changed', { orderId: 'x' });
    nsp.emit('order:status_changed', { orderId: 'y' });
    nsp.emit('some-experimental-event', { sessionId: 'abc' });

    const lines = await readMetric(registry, 'realtime_emit_total');
    expect(lines).toContain(
      'realtime_emit_total{namespace="/customer",event="order:status_changed"} 2',
    );
    expect(lines).toContain('realtime_emit_total{namespace="/customer",event="other"} 1');
    expect(lines).not.toContain('some-experimental-event');
  });

  it('detach() restores the original namespace emit and removes the connection listener', async () => {
    const registry = new Registry();
    const io = new FakeServer();
    const handle = attachSocketSpans({
      io: io as unknown as Parameters<typeof attachSocketSpans>[0]['io'],
      registry,
      namespaces: ['/customer'],
    });

    const nsp = io.of('/customer');
    nsp.emit('order:status_changed');
    handle.detach();
    nsp.emit('order:status_changed'); // should not increment after detach

    const lines = await readMetric(registry, 'realtime_emit_total');
    expect(lines).toContain(
      'realtime_emit_total{namespace="/customer",event="order:status_changed"} 1',
    );

    // After detach, a new connection should NOT bump the gauge.
    const beforeConnect = await readMetric(registry, 'realtime_active_connections');
    nsp.connect(new FakeSocket());
    const afterConnect = await readMetric(registry, 'realtime_active_connections');
    expect(afterConnect).toEqual(beforeConnect);
  });

  it('counts opened + closed totals across the connection lifecycle', async () => {
    const registry = new Registry();
    const io = new FakeServer();
    attachSocketSpans({
      io: io as unknown as Parameters<typeof attachSocketSpans>[0]['io'],
      registry,
      namespaces: ['/customer'],
    });

    const nsp = io.of('/customer');
    for (let i = 0; i < 3; i++) {
      const s = new FakeSocket();
      nsp.connect(s);
      s.disconnect();
    }

    const lines = await readMetric(registry, 'realtime_connections_total');
    expect(lines).toContain('realtime_connections_total{namespace="/customer",outcome="opened"} 3');
    expect(lines).toContain('realtime_connections_total{namespace="/customer",outcome="closed"} 3');
  });
});
