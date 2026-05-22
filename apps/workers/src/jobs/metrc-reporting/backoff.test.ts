/**
 * backoff schedule unit tests. The numbers here mirror spec §7.2 —
 * if a future spec revision retunes the ladder, change the spec and
 * this test together so the constants stay traceable.
 */
import { describe, expect, it } from 'vitest';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS, nextRetryAt } from './backoff.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const PIN = new Date('2026-05-19T12:00:00.000Z');

describe('RETRY_DELAYS_MS', () => {
  it('matches the 1m / 5m / 15m / 1h / 6h / 24h ladder from spec §7.2', () => {
    expect([...RETRY_DELAYS_MS]).toEqual([
      1 * ONE_MINUTE_MS,
      5 * ONE_MINUTE_MS,
      15 * ONE_MINUTE_MS,
      1 * ONE_HOUR_MS,
      6 * ONE_HOUR_MS,
      24 * ONE_HOUR_MS,
    ]);
  });

  it('is frozen — production code may not mutate the schedule in place', () => {
    expect(Object.isFrozen(RETRY_DELAYS_MS)).toBe(true);
  });

  it('MAX_RETRY_ATTEMPTS equals the array length (6 retries = 7 attempts)', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(6);
    expect(MAX_RETRY_ATTEMPTS).toBe(RETRY_DELAYS_MS.length);
  });
});

describe('nextRetryAt', () => {
  it('returns now + first delay when the very first attempt fails (retryCount=0)', () => {
    const next = nextRetryAt(PIN, 0);
    expect(next).not.toBeNull();
    expect(next?.toISOString()).toBe('2026-05-19T12:01:00.000Z');
  });

  it('walks the full ladder deterministically', () => {
    const expected = [
      '2026-05-19T12:01:00.000Z',
      '2026-05-19T12:05:00.000Z',
      '2026-05-19T12:15:00.000Z',
      '2026-05-19T13:00:00.000Z',
      '2026-05-19T18:00:00.000Z',
      '2026-05-20T12:00:00.000Z',
    ];
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const next = nextRetryAt(PIN, attempt);
      expect(next?.toISOString()).toBe(expected[attempt]);
    }
  });

  it('returns null once the ladder is exhausted (retryCount=MAX_RETRY_ATTEMPTS)', () => {
    expect(nextRetryAt(PIN, MAX_RETRY_ATTEMPTS)).toBeNull();
    expect(nextRetryAt(PIN, MAX_RETRY_ATTEMPTS + 5)).toBeNull();
  });

  it('throws RangeError for non-integer or negative retry counts (caller bug)', () => {
    expect(() => nextRetryAt(PIN, -1)).toThrow(RangeError);
    expect(() => nextRetryAt(PIN, 1.5)).toThrow(RangeError);
    expect(() => nextRetryAt(PIN, Number.NaN)).toThrow(RangeError);
  });

  it('does not mutate the passed-in `now` Date', () => {
    const original = PIN.getTime();
    nextRetryAt(PIN, 3);
    expect(PIN.getTime()).toBe(original);
  });
});
