import { describe, expect, it, vi } from 'vitest';
import { LocationBatcher } from './location-ingest.batcher.js';

describe('LocationBatcher', () => {
  it('flushes when buffer reaches maxSize', async () => {
    const flushed: number[][] = [];
    const batcher = new LocationBatcher<number>({
      maxSize: 3,
      maxLatencyMs: 10_000,
      onFlush: (items) => {
        flushed.push([...items]);
        return Promise.resolve();
      },
    });

    await batcher.enqueue(1);
    await batcher.enqueue(2);
    expect(flushed).toHaveLength(0);
    expect(batcher.size()).toBe(2);

    await batcher.enqueue(3);
    expect(flushed).toEqual([[1, 2, 3]]);
    expect(batcher.size()).toBe(0);
  });

  it('flushes on tick after the latency budget elapses from the first enqueue', async () => {
    const flushed: number[][] = [];
    const batcher = new LocationBatcher<number>({
      maxSize: 100,
      maxLatencyMs: 500,
      onFlush: (items) => {
        flushed.push([...items]);
        return Promise.resolve();
      },
    });

    await batcher.enqueue(1, 1_000);
    await batcher.enqueue(2, 1_100);
    await batcher.tick(1_400);
    expect(flushed).toHaveLength(0); // still inside the 500ms budget

    await batcher.tick(1_500); // exactly at the budget — not strictly greater
    expect(flushed).toEqual([[1, 2]]);
    expect(batcher.size()).toBe(0);
  });

  it('tick is a no-op on an empty buffer', async () => {
    const onFlush = vi.fn();
    const batcher = new LocationBatcher<number>({
      maxSize: 10,
      maxLatencyMs: 100,
      onFlush,
    });
    await batcher.tick(Number.MAX_SAFE_INTEGER);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('drain flushes whatever is buffered', async () => {
    const flushed: number[][] = [];
    const batcher = new LocationBatcher<number>({
      maxSize: 100,
      maxLatencyMs: 10_000,
      onFlush: (items) => {
        flushed.push([...items]);
        return Promise.resolve();
      },
    });
    await batcher.enqueue(7);
    await batcher.enqueue(8);
    await batcher.drain();
    expect(flushed).toEqual([[7, 8]]);
    await batcher.drain(); // second drain is a no-op
    expect(flushed).toEqual([[7, 8]]);
  });

  it('resets the latency clock after each flush', async () => {
    const flushed: number[][] = [];
    const batcher = new LocationBatcher<number>({
      maxSize: 100,
      maxLatencyMs: 500,
      onFlush: (items) => {
        flushed.push([...items]);
        return Promise.resolve();
      },
    });

    await batcher.enqueue(1, 0);
    await batcher.tick(600);
    expect(flushed).toEqual([[1]]);

    // Next enqueue starts a fresh window — tick at 800 should NOT flush
    // because the clock anchor reset to 700.
    await batcher.enqueue(2, 700);
    await batcher.tick(800);
    expect(flushed).toEqual([[1]]);

    await batcher.tick(1_300);
    expect(flushed).toEqual([[1], [2]]);
  });

  it('does not re-buffer items when onFlush throws', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const batcher = new LocationBatcher<number>({
      maxSize: 100,
      maxLatencyMs: 100,
      onFlush: handler,
    });

    await batcher.enqueue(1, 0);
    await expect(batcher.tick(1_000)).rejects.toThrow('boom');
    expect(batcher.size()).toBe(0);
  });

  it('rejects non-positive limits at construction', () => {
    const onFlush = (): Promise<void> => Promise.resolve();
    expect(() => new LocationBatcher({ maxSize: 0, maxLatencyMs: 100, onFlush })).toThrow();
    expect(() => new LocationBatcher({ maxSize: 10, maxLatencyMs: 0, onFlush })).toThrow();
  });
});
