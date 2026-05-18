/**
 * Direct Postgres access for integration tests.
 *
 * Wraps `@dankdash/db`'s `createPool` against the testcontainer URL exported
 * by vitest globalSetup. Tests use this for two things:
 *
 *   - `seedDefault()` calls the canonical `seed()` with `truncate: true`,
 *     so each test starts from the same deterministic catalog without
 *     paying the container boot cost.
 *   - `resetDb()` is the bare TRUNCATE for tests that want to drive a
 *     blank database (e.g. creating a fresh dispensary with no staff to
 *     exercise the activation gate).
 *
 * The pool is process-shared (vitest runs apps/api with `singleFork`) so
 * connection churn between tests stays at zero.
 */
import { createPool, seed, type Pool } from '@dankdash/db';
import { pino } from 'pino';

class TestEnvNotSetError extends Error {
  public override readonly name = 'TestEnvNotSetError';
  constructor() {
    super(
      'TEST_DATABASE_URL is not set. Did the vitest globalSetup run? Check apps/api/vitest.config.ts.',
    );
  }
}

const LOGGER = pino({ level: 'silent' });
let cached: Pool | undefined;

export function getPool(): Pool {
  if (cached !== undefined) return cached;
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url.length === 0) throw new TestEnvNotSetError();
  cached = createPool({
    databaseUrl: url,
    logger: LOGGER,
    maxConnections: 4,
    prepare: false,
    slowQueryThresholdMs: 10_000,
  });
  return cached;
}

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    audit_log,
    notifications, push_tokens,
    metrc_transactions, age_verifications, compliance_checks,
    dispatch_offers, driver_location_history, driver_shifts, drivers,
    refunds, payouts, ledger_entries, payment_transactions, payment_methods,
    order_events, order_status_history, order_items, orders,
    cart_items, carts,
    product_lab_results, dispensary_listings, products, product_categories,
    user_id_documents, user_addresses, sessions,
    dispensary_staff, dispensaries,
    users
  RESTART IDENTITY CASCADE;
`;

export async function resetDb(): Promise<void> {
  const pool = getPool();
  await pool.sql.unsafe(TRUNCATE_SQL);
}

export async function seedDefault(): Promise<void> {
  const pool = getPool();
  await seed({ db: pool.db, logger: LOGGER, truncate: true });
}
