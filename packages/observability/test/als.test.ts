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
import { getRequestContext, getRequestId, runWithRequestContext } from '../src/context/als.js';

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
});
