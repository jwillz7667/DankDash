import { FeatureDisabledError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { createDisabledFeatureProxy } from './disabled-feature.proxy.js';

interface FakeService {
  createInquiry(userId: string): Promise<void>;
  apiKey: string;
}

describe('createDisabledFeatureProxy', () => {
  it('throws FeatureDisabledError on any method access', () => {
    const proxy = createDisabledFeatureProxy<FakeService>('persona');
    expect(() => proxy.createInquiry('u_1')).toThrowError(FeatureDisabledError);
  });

  it('encodes the feature name + invoked property into the error details', () => {
    const proxy = createDisabledFeatureProxy<FakeService>('aeropay');
    try {
      void proxy.apiKey;
      expect.fail('expected access to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureDisabledError);
      const error = err as FeatureDisabledError;
      expect(error.code).toBe('FEATURE_DISABLED');
      expect(error.statusCode).toBe(503);
      expect(error.details).toEqual({ feature: 'aeropay', invokedProperty: 'apiKey' });
    }
  });

  it('returns undefined for symbol property access so framework introspection works', () => {
    const proxy = createDisabledFeatureProxy<FakeService>('persona') as unknown as {
      [Symbol.toPrimitive]?: () => string;
      [Symbol.iterator]?: () => Iterator<unknown>;
    };
    expect(proxy[Symbol.toPrimitive]).toBeUndefined();
    expect(proxy[Symbol.iterator]).toBeUndefined();
  });

  it('returns undefined for `then` so the proxy stays awaitable without tripping', async () => {
    const proxy = createDisabledFeatureProxy<FakeService>('twilio');
    // `Promise.resolve(value)` checks `value.then`; if `then` threw, the
    // await chain itself would surface the feature-disabled error before
    // user code had a chance to react. Returning undefined keeps the
    // proxy resolvable to itself so the calling code can structure
    // method invocations as it sees fit.
    await expect(Promise.resolve(proxy)).resolves.toBe(proxy);
  });
});
