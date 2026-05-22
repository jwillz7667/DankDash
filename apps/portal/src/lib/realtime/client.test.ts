import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type OrderStatusChange, type OrderSummary } from './client.js';

type AnyListener = (...args: unknown[]) => void;

interface ConnectOptions {
  readonly auth: { readonly token: string; readonly dispensaryId?: string };
}

interface FakeSocket {
  readonly listeners: Map<string, Set<AnyListener>>;
  emit(event: string, payload: unknown): void;
  emitConnect(): void;
  emitDisconnect(): void;
  emitConnectError(): void;
  on(event: string, listener: AnyListener): FakeSocket;
  off(event: string, listener: AnyListener): FakeSocket;
  removeAllListeners(): FakeSocket;
  disconnect(): FakeSocket;
}

function createFakeSocket(): FakeSocket {
  const listeners = new Map<string, Set<AnyListener>>();

  const fakeSocket: FakeSocket = {
    listeners,
    emit(event, payload) {
      listeners.get(event)?.forEach((l) => {
        l(payload);
      });
    },
    emitConnect() {
      listeners.get('connect')?.forEach((l) => {
        l();
      });
    },
    emitDisconnect() {
      listeners.get('disconnect')?.forEach((l) => {
        l();
      });
    },
    emitConnectError() {
      listeners.get('connect_error')?.forEach((l) => {
        l(new Error('boom'));
      });
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return fakeSocket;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return fakeSocket;
    },
    removeAllListeners() {
      listeners.clear();
      return fakeSocket;
    },
    disconnect() {
      return fakeSocket;
    },
  };
  return fakeSocket;
}

interface CapturedFactoryCall {
  readonly url: string;
  readonly options: ConnectOptions;
}

function buildFactory(socket: FakeSocket): {
  readonly factory: (url: string, opts: ConnectOptions) => Socket;
  readonly calls: CapturedFactoryCall[];
} {
  const calls: CapturedFactoryCall[] = [];
  const factory = (url: string, opts: ConnectOptions): Socket => {
    calls.push({ url, options: opts });
    return socket as unknown as Socket;
  };
  return { factory, calls };
}

describe('RealtimeClient', () => {
  it('connects to the /vendor namespace with the bearer token in auth', () => {
    const fake = createFakeSocket();
    const { factory, calls } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      dispensaryId: 'd-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });

    client.connect();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('wss://rt.test/vendor');
    expect(calls[0]?.options.auth.token).toBe('jwt-1');
    expect(calls[0]?.options.auth.dispensaryId).toBe('d-1');
  });

  it('is idempotent — calling connect twice opens at most one socket', () => {
    const fake = createFakeSocket();
    const { factory, calls } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });
    client.connect();
    client.connect();
    expect(calls).toHaveLength(1);
  });

  it('reports status transitions to subscribers', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });

    const observed: string[] = [];
    const unsub = client.onStatusChange((s) => observed.push(s));
    expect(observed).toEqual(['idle']);

    client.connect();
    expect(observed).toEqual(['idle', 'connecting']);

    fake.emitConnect();
    expect(observed).toEqual(['idle', 'connecting', 'connected']);

    fake.emitDisconnect();
    expect(observed).toEqual(['idle', 'connecting', 'connected', 'disconnected']);

    fake.emitConnectError();
    expect(observed).toEqual(['idle', 'connecting', 'connected', 'disconnected', 'error']);

    unsub();
    fake.emitDisconnect();
    expect(observed).toHaveLength(5);
  });

  it('does not re-notify subscribers on a duplicate status', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });

    const observed: string[] = [];
    client.onStatusChange((s) => observed.push(s));
    client.connect();
    fake.emitConnect();
    fake.emitConnect();
    expect(observed.filter((s) => s === 'connected')).toHaveLength(1);
  });

  it('delivers typed event payloads to handlers', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });

    client.connect();

    const created: OrderSummary[] = [];
    const status: OrderStatusChange[] = [];
    client.on('order:created', (p) => created.push(p));
    client.on('order:status_changed', (p) => status.push(p));

    const orderCreated: OrderSummary = {
      orderId: 'o-1',
      customerId: 'c-1',
      dispensaryId: 'd-1',
      shortCode: 'AAA-111',
      totalCents: 7500,
      status: 'placed',
      placedAt: '2026-05-19T12:00:00Z',
    };
    const orderStatus: OrderStatusChange = {
      orderId: 'o-1',
      customerId: 'c-1',
      dispensaryId: 'd-1',
      driverId: null,
      fromStatus: 'placed',
      toStatus: 'accepted',
      changedAt: '2026-05-19T12:01:00Z',
    };
    fake.emit('order:created', orderCreated);
    fake.emit('order:status_changed', orderStatus);

    expect(created).toEqual([orderCreated]);
    expect(status).toEqual([orderStatus]);
  });

  it('returns a disposer that detaches the handler', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });
    client.connect();

    const calls: OrderSummary[] = [];
    const unsub = client.on('order:created', (p) => calls.push(p));

    const payload: OrderSummary = {
      orderId: 'o-1',
      customerId: 'c-1',
      dispensaryId: 'd-1',
      shortCode: 'AAA-111',
      totalCents: 7500,
      status: 'placed',
      placedAt: '2026-05-19T12:00:00Z',
    };
    fake.emit('order:created', payload);
    unsub();
    fake.emit('order:created', payload);

    expect(calls).toHaveLength(1);
  });

  it('rejects on() when called before connect()', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });
    expect(() => client.on('order:created', vi.fn())).toThrow(/before connect/u);
  });

  it('disconnect() clears socket state and returns status to idle', () => {
    const fake = createFakeSocket();
    const { factory } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });

    const observed: string[] = [];
    client.onStatusChange((s) => observed.push(s));
    client.connect();
    fake.emitConnect();
    client.disconnect();

    expect(client.getStatus()).toBe('idle');
    expect(observed[observed.length - 1]).toBe('idle');
  });

  it('omits dispensaryId from the handshake auth when not provided', () => {
    const fake = createFakeSocket();
    const { factory, calls } = buildFactory(fake);
    const client = new RealtimeClient({
      url: 'wss://rt.test',
      token: 'jwt-1',
      socketFactory: factory as unknown as RealtimeClient['factory'],
    });
    client.connect();
    expect(calls[0]?.options.auth.dispensaryId).toBeUndefined();
  });
});
