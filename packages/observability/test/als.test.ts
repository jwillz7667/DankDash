/**
 * AsyncLocalStorage context propagation.
 *
 * These tests validate the contract that:
 *  - context propagates across `await` boundaries
 *  - concurrent stores do not leak into one another
 *  - reading outside any store returns `undefined`
 *
 * If any of these break, every consumer (pino mixin, Sentry, span
 * enrichment) silently emits records with the wrong request id —
 * the worst kind of observability bug because the records still look
 * valid.
 */
import { describe, expect, it } from 'vitest';
import {
  enterRequestContext,
  getRequestContext,
  getRequestId,
  runWithRequestContext,
  updateRequestContext,
} from '../src/context/als.js';

describe('AsyncLocalStorage request context', () => {
  it('returns undefined when called outside any runWithRequestContext boundary', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('returns the stored context inside the boundary', () => {
    runWithRequestContext({ requestId: 'r-1', userId: 'u-1' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'r-1', userId: 'u-1' });
      expect(getRequestId()).toBe('r-1');
    });
  });

  it('propagates context across awaits', async () => {
    await runWithRequestContext({ requestId: 'r-2' }, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getRequestId()).toBe('r-2');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(getRequestId()).toBe('r-2');
    });
  });

  it('isolates concurrent stores — two parallel requests never observe each other', async () => {
    const observations: string[] = [];
    const work = async (id: string): Promise<void> => {
      await runWithRequestContext({ requestId: id }, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        const ctx = getRequestId();
        if (ctx !== undefined) observations.push(ctx);
      });
    };
    await Promise.all([work('a'), work('b'), work('c'), work('d')]);
    expect(observations.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('nested runWithRequestContext shadows the parent and restores it on exit', () => {
    runWithRequestContext({ requestId: 'outer' }, () => {
      expect(getRequestId()).toBe('outer');
      runWithRequestContext({ requestId: 'inner' }, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
    expect(getRequestId()).toBeUndefined();
  });

  it('enterRequestContext pushes onto the current scope without a wrapper', async () => {
    // enterWith mutates the current async scope; we need a child
    // resource that doesn't leak back to the test runner. Wrap in
    // `runWithRequestContext` with a sentinel context, then call
    // `enterRequestContext` to swap; the wrapper scope cleans up.
    const captured = await runWithRequestContext({ requestId: 'sentinel' }, async () => {
      enterRequestContext({ requestId: 'entered', userId: 'u-9' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return getRequestContext();
    });
    expect(captured).toEqual({ requestId: 'entered', userId: 'u-9' });
    // Outside the wrapper, no leakage.
    expect(getRequestContext()).toBeUndefined();
  });

  it('updateRequestContext mutates the current store in place', () => {
    runWithRequestContext({ requestId: 'r-update' }, () => {
      expect(updateRequestContext({ userId: 'u-late', dispensaryId: 'd-late' })).toBe(true);
      expect(getRequestContext()).toEqual({
        requestId: 'r-update',
        userId: 'u-late',
        dispensaryId: 'd-late',
      });
    });
  });

  it('updateRequestContext returns false when no active context', () => {
    expect(updateRequestContext({ userId: 'orphan' })).toBe(false);
  });
});
