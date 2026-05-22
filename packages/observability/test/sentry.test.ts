/**
 * Sentry initializer — env-gated, ALS-tagged.
 *
 * No real DSN is exercised. The tests cover:
 *
 *  - With no DSN: returns the no-op handle so test runs never depend
 *    on a Sentry project.
 *  - With a DSN: returns an `initialized: true` handle whose
 *    `captureException` and `close` are real (no exception thrown).
 *
 * The beforeSend hook is not exercised end-to-end here — that would
 * need a real Sentry transport. The hook is small and pure (reads
 * ALS, merges tags) and has its behaviour covered indirectly by the
 * ALS test.
 */
import { describe, expect, it } from 'vitest';
import { initSentry } from '../src/errors/sentry.js';

describe('initSentry', () => {
  it('returns a no-op handle when DSN is unset', () => {
    const handle = initSentry({
      serviceName: 'api',
      serviceVersion: '0.0.0',
      environment: 'test',
    });
    expect(handle.initialized).toBe(false);

    // Both methods must be callable and return resolved promises /
    // void — the no-op handle is the contract test runs depend on.
    handle.captureException(new Error('ignored'));
    return expect(handle.close(1)).resolves.toBe(true);
  });

  it('returns a no-op handle when DSN is an empty string', () => {
    const handle = initSentry({
      dsn: '',
      serviceName: 'api',
      serviceVersion: '0.0.0',
      environment: 'test',
    });
    expect(handle.initialized).toBe(false);
  });

  it('returns an initialized handle when DSN is set', async () => {
    // A syntactically-valid DSN that points nowhere. Sentry's init
    // accepts any well-formed URL; the transport will fail silently
    // in the background, which is fine for this contract test.
    const handle = initSentry({
      dsn: 'https://public@example.com/1',
      serviceName: 'api',
      serviceVersion: '1.2.3',
      environment: 'test',
      tracesSampleRate: 0,
    });
    expect(handle.initialized).toBe(true);

    // captureException + close must not throw.
    handle.captureException(new Error('test'), { foo: 'bar' });
    const closed = await handle.close(50);
    expect(typeof closed).toBe('boolean');
  });
});
