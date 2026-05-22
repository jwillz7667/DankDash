/**
 * Backoff schedule for the Metrc reporting worker.
 *
 * Per `DankDash-Technical-Spec.md` §7.2: every delivered order produces a
 * Metrc sales receipt; on transient failure the worker retries on a
 * 1m / 5m / 15m / 1h / 6h / 24h schedule (six retries — seven attempts
 * total). After that the row goes terminal `failed` and surfaces in the
 * `metrc_transactions_failed_idx` admin view for manual intervention.
 *
 * The schedule is encoded as an array of millisecond delays indexed by
 * `retryCount` — i.e. when the worker observes a row with
 * `retryCount = N` and the attempt fails transiently, the next attempt
 * is scheduled at `now + RETRY_DELAYS_MS[N]`. When `N` is out of bounds
 * (no more delays left), the worker terminates the row.
 *
 * Why an array rather than `1m * 5^N`-style geometric formula: the
 * schedule in the spec is hand-tuned (5× then 3× then 4× then 6× then
 * 4×) and lifted directly from operational experience at one of the
 * partner dispensaries. Encoding the exact numbers keeps the test
 * assertions readable and makes a spec change a one-line diff.
 */

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;

export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1 * ONE_MINUTE, // attempt 1 failed → wait 1m for attempt 2
  5 * ONE_MINUTE, // attempt 2 failed → wait 5m
  15 * ONE_MINUTE, // attempt 3 failed → wait 15m
  1 * ONE_HOUR, // attempt 4 failed → wait 1h
  6 * ONE_HOUR, // attempt 5 failed → wait 6h
  24 * ONE_HOUR, // attempt 6 failed → wait 24h (final retry before terminal)
]);

export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * Returns the next attempt time, or `null` when the row has exhausted
 * its backoff budget and the caller should terminate it.
 *
 * `retryCount` is the row's PRE-FAILURE count — i.e. the number of
 * attempts that have already failed. A fresh row reaches the worker
 * with `retryCount = 0`; if that first attempt fails transiently we
 * pass `0` here and get back `now + 1m`. After 6 transient failures
 * (`retryCount = 6`) we get back `null`.
 */
export function nextRetryAt(now: Date, retryCount: number): Date | null {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new RangeError(
      `nextRetryAt: retryCount must be a non-negative integer, got ${String(retryCount)}`,
    );
  }
  const delay = RETRY_DELAYS_MS[retryCount];
  if (delay === undefined) return null;
  return new Date(now.getTime() + delay);
}
