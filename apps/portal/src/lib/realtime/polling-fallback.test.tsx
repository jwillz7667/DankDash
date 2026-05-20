import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  useQueueSnapshotPolling,
  type QueueSnapshotPollingResult,
  type UseQueueSnapshotPollingOptions,
} from './polling-fallback.js';

interface HostProps<T> {
  readonly options: UseQueueSnapshotPollingOptions<T>;
  readonly onResult: (r: QueueSnapshotPollingResult<T>) => void;
}

function Host<T>({ options, onResult }: HostProps<T>): ReactNode {
  onResult(useQueueSnapshotPolling(options));
  return null;
}

/**
 * A fetcher whose promise can be resolved or rejected from the
 * outside, with a counter for how many times it was invoked. Lets a
 * test step through "schedule a poll → assert it fired but is in
 * flight → resolve/reject manually → assert effect".
 */
function deferredFetcher<T>(): {
  readonly fn: () => Promise<T>;
  readonly callCount: () => number;
  resolveNext(value: T): Promise<void>;
  rejectNext(reason: unknown): Promise<void>;
} {
  let resolveFn: ((v: T) => void) | null = null;
  let rejectFn: ((reason: unknown) => void) | null = null;
  let calls = 0;
  const fn = (): Promise<T> => {
    calls += 1;
    return new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  };
  return {
    fn,
    callCount: (): number => calls,
    async resolveNext(value: T): Promise<void> {
      const r = resolveFn;
      resolveFn = null;
      rejectFn = null;
      r?.(value);
      // Flush the resolved microtask + the effect that updates state.
      await Promise.resolve();
      await Promise.resolve();
    },
    async rejectNext(reason: unknown): Promise<void> {
      const r = rejectFn;
      resolveFn = null;
      rejectFn = null;
      r?.(reason);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('useQueueSnapshotPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll while disabled', () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: false,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetcher.callCount()).toBe(0);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(captured!.active).toBe(false);
  });

  it('fires the first poll after the grace window when enabled', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 50,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );
    // Inside grace window — nothing fired yet.
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(fetcher.callCount()).toBe(0);
    expect(captured!.active).toBe(false);

    // Grace expires — first poll fires.
    act(() => {
      vi.advanceTimersByTime(15);
    });
    expect(fetcher.callCount()).toBe(1);
    expect(captured!.active).toBe(true);

    await act(async () => {
      await fetcher.resolveNext('snapshot-1');
    });
    expect(onSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(captured!.lastPolledAt).not.toBeNull();
    expect(captured!.error).toBeNull();
  });

  it('continues polling on the interval after the first response', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 50,
        }}
        onResult={(): void => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fetcher.callCount()).toBe(1);
    await act(async () => {
      await fetcher.resolveNext('snapshot-1');
    });

    // Tick once: second poll.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher.callCount()).toBe(2);
    await act(async () => {
      await fetcher.resolveNext('snapshot-2');
    });
    expect(onSnapshot).toHaveBeenNthCalledWith(2, 'snapshot-2');

    // Tick again: third poll.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher.callCount()).toBe(3);
  });

  it('cancels the pending grace timer when disabled mid-grace', () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    const { rerender } = render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 50,
        }}
        onResult={(): void => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(20);
    });

    // Reconnected — flip enabled false before grace expires.
    rerender(
      <Host<string>
        options={{
          enabled: false,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 50,
        }}
        onResult={(): void => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetcher.callCount()).toBe(0);
  });

  it('discards an in-flight response that resolves after disable', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    const { rerender } = render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(): void => undefined}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(fetcher.callCount()).toBe(1);

    // WS reconnects between fire and resolve.
    rerender(
      <Host<string>
        options={{
          enabled: false,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(): void => undefined}
      />,
    );

    await act(async () => {
      await fetcher.resolveNext('stale-snapshot');
    });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('captures fetcher errors and keeps polling on the next tick', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(fetcher.callCount()).toBe(1);
    await act(async () => {
      await fetcher.rejectNext(new Error('network down'));
    });
    expect(captured!.error?.message).toBe('network down');
    expect(onSnapshot).not.toHaveBeenCalled();

    // Next tick still fires.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher.callCount()).toBe(2);
    await act(async () => {
      await fetcher.resolveNext('recovered');
    });
    expect(onSnapshot).toHaveBeenCalledWith('recovered');
    expect(captured!.error).toBeNull();
  });

  it('wraps a non-Error rejection in an Error so consumers can rely on .message', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10);
    });
    await act(async () => {
      await fetcher.rejectNext('plain string rejection');
    });
    expect(captured!.error).toBeInstanceOf(Error);
    expect(captured!.error?.message).toBe('Polling fetch failed');
  });

  it('skips a tick while a previous poll is still in flight (single-flight)', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(): void => undefined}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(fetcher.callCount()).toBe(1);

    // Tick before the response resolves — should be skipped.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher.callCount()).toBe(1);

    await act(async () => {
      await fetcher.resolveNext('snapshot-1');
    });

    // Next tick can fire now.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fetcher.callCount()).toBe(2);
  });

  it('cleans up timers and discards responses on unmount', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    const { unmount } = render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(): void => undefined}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(fetcher.callCount()).toBe(1);

    unmount();
    await act(async () => {
      await fetcher.resolveNext('post-unmount');
    });
    expect(onSnapshot).not.toHaveBeenCalled();

    // Make sure no interval keeps ticking.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetcher.callCount()).toBe(1);
  });

  it('exposes a manual poll() that fires immediately when enabled', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: true,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100_000,
          gracePeriodMs: 100_000,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );

    // Grace hasn't expired — no auto poll, but manual poll should fire.
    expect(fetcher.callCount()).toBe(0);
    let pollPromise: Promise<string | null> | undefined;
    act(() => {
      pollPromise = captured!.poll();
    });
    expect(fetcher.callCount()).toBe(1);
    await act(async () => {
      await fetcher.resolveNext('manual-snapshot');
      await pollPromise;
    });
    expect(onSnapshot).toHaveBeenCalledWith('manual-snapshot');
  });

  it('manual poll() is a no-op when disabled', async () => {
    const fetcher = deferredFetcher<string>();
    const onSnapshot = vi.fn();
    let captured: QueueSnapshotPollingResult<string> | null = null;
    render(
      <Host<string>
        options={{
          enabled: false,
          fetcher: fetcher.fn,
          onSnapshot,
          intervalMs: 100,
          gracePeriodMs: 10,
        }}
        onResult={(r): void => {
          captured = r;
        }}
      />,
    );
    let result: string | null = 'initial';
    await act(async () => {
      result = await captured!.poll();
    });
    expect(result).toBeNull();
    expect(fetcher.callCount()).toBe(0);
  });
});
