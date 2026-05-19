/**
 * Transactional test isolation.
 *
 * `withTransaction` opens a transaction, runs the callback against the
 * transaction-scoped Drizzle handle, and ALWAYS rolls back — even when the
 * callback succeeds. The point isn't to roll back failures; the point is to
 * give each test a clean database state without paying the cost of a real
 * truncate / migrate cycle.
 *
 * Caveats:
 *   - The callback receives a transaction handle whose type is a structural
 *     subset of `Database`. Code under test that needs the surrounding pool's
 *     `timed()` / `close()` should not be exercised via this helper.
 *   - Postgres `SELECT pg_advisory_lock(...)` and other connection-scoped
 *     state are released by the rollback. If a test depends on lock survival
 *     across the test boundary, use truncateAll instead.
 *   - A unique sentinel error is thrown to force the rollback; the helper
 *     catches it and rethrows whatever the callback returned/threw.
 */
import { type Pool } from '@dankdash/db';

class TestRollbackSentinel extends Error {
  public override readonly name = 'TestRollbackSentinel';
  constructor() {
    super('test transaction rolled back (expected)');
  }
}

class TransactionNeverRanError extends Error {
  public override readonly name = 'TransactionNeverRanError';
  constructor() {
    super('withTransaction: callback never ran');
  }
}

type Tx = Parameters<Parameters<Pool['db']['transaction']>[0]>[0];

export async function withTransaction<T>(pool: Pool, callback: (tx: Tx) => Promise<T>): Promise<T> {
  let captured: { ok: true; value: T } | { ok: false; error: unknown } | undefined;

  try {
    await pool.db.transaction(async (tx) => {
      try {
        const value = await callback(tx);
        captured = { ok: true, value };
      } catch (error) {
        captured = { ok: false, error };
      }
      // Always abort the transaction. The sentinel is caught below.
      throw new TestRollbackSentinel();
    });
  } catch (error) {
    if (!(error instanceof TestRollbackSentinel)) {
      // Unexpected: the rollback path itself failed. Surface it so the test
      // sees the real problem rather than a swallowed rollback error.
      throw error;
    }
  }

  if (captured === undefined) {
    // Should be unreachable — the transaction callback always runs to either
    // the value-capture path or the error-capture path before the sentinel.
    throw new TransactionNeverRanError();
  }
  if (captured.ok) return captured.value;
  throw captured.error;
}
