import { act, render } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeClient,
  type OrderStatusChange,
  type OrderSummary,
  type RealtimeEventHandler,
  type RealtimeEventName,
  type RealtimeStatus,
  type StatusListener,
} from './client.js';
import { useRealtimeOrders, type UseRealtimeOrdersOptions } from './hooks.js';

class FakeClient extends RealtimeClient {
  public connectCalls = 0;
  public disconnectCalls = 0;
  private statusListener: StatusListener | null = null;
  private orderCreatedHandler: RealtimeEventHandler<'order:created'> | null = null;
  private orderStatusHandler: RealtimeEventHandler<'order:status_changed'> | null = null;

  constructor() {
    // FakeClient bypasses the socket entirely — we never call super.connect(),
    // never reach socket.io, so the constructor args are irrelevant.
    super({ url: 'wss://test', token: 't' });
  }

  override connect(): void {
    this.connectCalls += 1;
  }

  override disconnect(): void {
    this.disconnectCalls += 1;
  }

  override onStatusChange(listener: StatusListener): () => void {
    this.statusListener = listener;
    listener('connecting');
    return () => {
      this.statusListener = null;
    };
  }

  override on<E extends RealtimeEventName>(event: E, handler: RealtimeEventHandler<E>): () => void {
    if (event === 'order:created') {
      this.orderCreatedHandler = handler as RealtimeEventHandler<'order:created'>;
      return () => {
        this.orderCreatedHandler = null;
      };
    }
    this.orderStatusHandler = handler as RealtimeEventHandler<'order:status_changed'>;
    return () => {
      this.orderStatusHandler = null;
    };
  }

  emitStatus(s: RealtimeStatus): void {
    this.statusListener?.(s);
  }
  emitCreated(p: OrderSummary): void {
    this.orderCreatedHandler?.(p);
  }
  emitStatusChange(p: OrderStatusChange): void {
    this.orderStatusHandler?.(p);
  }
}

function Harness(props: {
  readonly options: UseRealtimeOrdersOptions;
  readonly onState?: (status: RealtimeStatus) => void;
}): ReactNode {
  const { status } = useRealtimeOrders(props.options);
  const [, setLast] = useState<RealtimeStatus>('idle');
  useEffect(() => {
    setLast(status);
    props.onState?.(status);
  }, [status, props]);
  return <span data-testid="status">{status}</span>;
}

describe('useRealtimeOrders', () => {
  it('opens the client on mount, sets status, and tears down on unmount', () => {
    const fake = new FakeClient();
    const factory = vi.fn(() => fake);
    const { getByTestId, unmount } = render(
      <Harness options={{ url: 'wss://test', token: 'jwt-1', clientFactory: factory }} />,
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.connectCalls).toBe(1);
    // Initial onStatusChange call fires synchronously with 'connecting'.
    expect(getByTestId('status').textContent).toBe('connecting');

    act(() => {
      fake.emitStatus('connected');
    });
    expect(getByTestId('status').textContent).toBe('connected');

    unmount();
    expect(fake.disconnectCalls).toBe(1);
  });

  it('skips connecting when enabled=false', () => {
    const fake = new FakeClient();
    const factory = vi.fn(() => fake);
    const { getByTestId } = render(
      <Harness
        options={{ url: 'wss://test', token: 'jwt-1', enabled: false, clientFactory: factory }}
      />,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(fake.connectCalls).toBe(0);
    expect(getByTestId('status').textContent).toBe('idle');
  });

  it('skips connecting when no token is present', () => {
    const fake = new FakeClient();
    const factory = vi.fn(() => fake);
    render(<Harness options={{ url: 'wss://test', token: '', clientFactory: factory }} />);
    expect(factory).not.toHaveBeenCalled();
  });

  it('forwards order:created events to the supplied handler', () => {
    const fake = new FakeClient();
    const factory = vi.fn(() => fake);
    const onCreated = vi.fn();
    render(
      <Harness
        options={{
          url: 'wss://test',
          token: 'jwt-1',
          clientFactory: factory,
          onCreated,
        }}
      />,
    );

    const payload: OrderSummary = {
      orderId: 'o-1',
      customerId: 'c-1',
      dispensaryId: 'd-1',
      shortCode: 'AAA-111',
      totalCents: 7500,
      status: 'placed',
      placedAt: '2026-05-19T12:00:00Z',
    };
    act(() => {
      fake.emitCreated(payload);
    });
    expect(onCreated).toHaveBeenCalledWith(payload);
  });

  it('uses the latest handler closure without tearing down the socket', () => {
    const fake = new FakeClient();
    const factory = vi.fn(() => fake);
    const v1 = vi.fn();
    const v2 = vi.fn();

    const { rerender } = render(
      <Harness
        options={{ url: 'wss://test', token: 'jwt-1', clientFactory: factory, onCreated: v1 }}
      />,
    );

    rerender(
      <Harness
        options={{ url: 'wss://test', token: 'jwt-1', clientFactory: factory, onCreated: v2 }}
      />,
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.disconnectCalls).toBe(0);

    const payload: OrderSummary = {
      orderId: 'o-1',
      customerId: 'c-1',
      dispensaryId: 'd-1',
      shortCode: 'AAA-111',
      totalCents: 7500,
      status: 'placed',
      placedAt: '2026-05-19T12:00:00Z',
    };
    act(() => {
      fake.emitCreated(payload);
    });
    expect(v1).not.toHaveBeenCalled();
    expect(v2).toHaveBeenCalledWith(payload);
  });

  it('reopens when the URL or token identity changes', () => {
    const factory = vi.fn(() => new FakeClient());
    const { rerender } = render(
      <Harness options={{ url: 'wss://a', token: 'jwt-1', clientFactory: factory }} />,
    );
    expect(factory).toHaveBeenCalledTimes(1);

    rerender(<Harness options={{ url: 'wss://b', token: 'jwt-1', clientFactory: factory }} />);
    expect(factory).toHaveBeenCalledTimes(2);

    rerender(<Harness options={{ url: 'wss://b', token: 'jwt-2', clientFactory: factory }} />);
    expect(factory).toHaveBeenCalledTimes(3);
  });
});
