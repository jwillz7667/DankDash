/**
 * Named seed scenarios for integration tests.
 *
 * `seedScenario(db, name)` populates a fresh schema with a specific fixture
 * shape so tests can write `await seedScenario(db, 'happy-path')` instead of
 * hand-rolling inserts in each suite. Each scenario truncates first to
 * guarantee a known starting state, then layers in the fixtures.
 *
 * Available scenarios:
 *   - 'default'        Full deterministic catalog (delegates to @dankdash/db seed).
 *   - 'empty'          Truncate only — used by tests asserting empty-DB behavior.
 *   - 'minimal'        One dispensary, one customer, one product, one listing.
 *     For tests that need *just enough* state without the full catalog cost.
 */
import { type Database, seed, type SeedSummary, stableUuid } from '@dankdash/db';
import { pino } from 'pino';

export type ScenarioName = 'default' | 'empty' | 'minimal';

export interface SeedScenarioResult {
  readonly scenario: ScenarioName;
  readonly summary: Partial<SeedSummary>;
}

const TRUNCATE_ALL_SQL = `
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

const SILENT_LOGGER = pino({ level: 'silent' });

async function truncateAll(db: Database): Promise<void> {
  await db.execute(TRUNCATE_ALL_SQL);
}

async function seedMinimal(db: Database): Promise<Partial<SeedSummary>> {
  // We use the same stableUuid namespace so a 'minimal' scenario's IDs are
  // stable across runs, just as the 'default' scenario's are. Tests can
  // reference these IDs directly (e.g. `stableUuid('minimal-user', 'alice')`).
  const userId = stableUuid('minimal-user', 'alice');
  const dispensaryId = stableUuid('minimal-dispensary', 'downtown');
  const categoryId = stableUuid('minimal-category', 'flower');
  const productId = stableUuid('minimal-product', 'house-flower');
  const listingId = stableUuid('minimal-listing', `${dispensaryId}:${productId}`);

  await db.execute(`
    INSERT INTO users (id, email, status, role, dob, full_name, password_hash)
    VALUES (
      '${userId}',
      'alice@example.test',
      'active',
      'consumer',
      DATE '2000-01-01',
      'Alice Customer',
      '$seed$placeholder-not-bcrypt-do-not-use-in-prod'
    );
  `);

  await db.execute(`
    INSERT INTO dispensaries (
      id, legal_name, dba, license_number, license_type,
      license_issued_at, license_expires_at,
      address_line1, city, region, postal_code,
      location, delivery_polygon, hours_json,
      is_accepting_orders
    )
    VALUES (
      '${dispensaryId}',
      'Minimal Dispensary LLC',
      'Minimal',
      'MN-TEST-001',
      'retailer',
      DATE '2025-01-01',
      DATE '2030-01-01',
      '100 Test St', 'Minneapolis', 'MN', '55401',
      ST_GeogFromText('SRID=4326;POINT(-93.265 44.978)'),
      ST_GeogFromText('SRID=4326;POLYGON((-93.30 44.95, -93.20 44.95, -93.20 45.00, -93.30 45.00, -93.30 44.95))'),
      '{"mon":["08:00","26:00"],"tue":["08:00","26:00"],"wed":["08:00","26:00"],"thu":["08:00","26:00"],"fri":["08:00","26:00"],"sat":["08:00","26:00"],"sun":["08:00","26:00"]}'::jsonb,
      true
    );
  `);

  await db.execute(`
    INSERT INTO product_categories (id, slug, name, product_type)
    VALUES ('${categoryId}', 'flower', 'Flower', 'flower');
  `);

  await db.execute(`
    INSERT INTO products (
      id, category_id, brand, name, product_type,
      strain_name, strain_type, thc_mg_total, weight_grams,
      is_active
    )
    VALUES (
      '${productId}',
      '${categoryId}',
      'Test Brand',
      'House Flower 3.5g',
      'flower',
      'Test Strain',
      'hybrid',
      525,
      3.5,
      true
    );
  `);

  await db.execute(`
    INSERT INTO dispensary_listings (
      id, dispensary_id, product_id, sku,
      price_cents, inventory_quantity, is_published
    )
    VALUES (
      '${listingId}',
      '${dispensaryId}',
      '${productId}',
      'TEST-001',
      4500,
      100,
      true
    );
  `);

  return { users: 1, dispensaries: 1, products: 1, listings: 1 };
}

export async function seedScenario(db: Database, name: ScenarioName): Promise<SeedScenarioResult> {
  await truncateAll(db);

  if (name === 'empty') {
    return { scenario: 'empty', summary: {} };
  }

  if (name === 'minimal') {
    const summary = await seedMinimal(db);
    return { scenario: 'minimal', summary };
  }

  // Default — full deterministic fixture set. seed() does its own truncate
  // so the duplicate is wasted work; passing truncate: false here cooperates.
  const summary = await seed({ db, logger: SILENT_LOGGER, truncate: false });
  return { scenario: 'default', summary };
}
