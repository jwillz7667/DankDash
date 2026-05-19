/**
 * Per-test-file setup. Establishes a single shared `Pool` against the
 * container booted by `global-setup.ts` and exposes helpers tests use to
 * grab a clean state at suite start.
 *
 * Test files import { getPool, resetDb, seedDefault } from './setup.js'.
 * No global side effects beyond the lazy pool initialization.
 */
import { pino } from 'pino';
// Use a relative import here so the self-reference works even before
// `pnpm build` has produced `dist/index.d.ts` — the package-name alias
// `@dankdash/db` only resolves against the built artifacts. Same pattern as
// `test/global-setup.ts`.
import { createPool, type Pool, seed } from '../src/index.js';

class TestEnvNotSetError extends Error {
  public override readonly name = 'TestEnvNotSetError';
  constructor() {
    super('TEST_DATABASE_URL is not set. Did the vitest globalSetup run? Check vitest.config.ts.');
  }
}

let cached: Pool | undefined;
const LOGGER = pino({ level: 'silent' });

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
