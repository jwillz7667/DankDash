/**
 * Seed determinism + basic repository read coverage.
 *
 * After running the seed once, the same UUIDs must be produced on every
 * subsequent run — the consumer iOS app caches deeply on these IDs in dev,
 * and tests across the monorepo reference them as fixtures.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgeVerificationsRepository,
  AuditLogRepository,
  CartItemsRepository,
  ComplianceChecksRepository,
  DispensariesRepository,
  DispensaryListingsRepository,
  DispensaryStaffRepository,
  DriversRepository,
  LedgerEntriesRepository,
  MetrcTransactionsRepository,
  NotificationsRepository,
  OrdersRepository,
  PaymentMethodsRepository,
  PayoutsRepository,
  ProductCategoriesRepository,
  ProductsRepository,
  PushTokensRepository,
  stableUuid,
  UsersRepository,
} from '../../src/index.js';
import { getPool, seedDefault } from '../setup.js';

describe('seed + repositories', () => {
  beforeAll(async () => {
    await seedDefault();
  }, 60_000);

  it('produces stable UUIDs across runs (UUID v5)', async () => {
    const pool = getPool();
    const users = new UsersRepository(pool.db);

    const aliceId = stableUuid('user', 'customer-1');
    const alice = await users.findById(aliceId);
    expect(alice).not.toBeNull();
    expect(alice?.email).toBe('alice.kim@example.com');
    // UUID v5 has '5' at the 13th hex position (the version digit, right
    // after the second '-': "xxxxxxxx-xxxx-Vxxx-yxxx-xxxxxxxxxxxx").
    expect(aliceId.charAt(14)).toBe('5');
  });

  it('seeded 3 dispensaries with PostGIS geometry inflated to GeoPoint', async () => {
    const pool = getPool();
    const dispensaries = new DispensariesRepository(pool.db);

    const all = await dispensaries.listActive();
    expect(all.length).toBe(3);

    const mpls = all.find((d) => d.dba === 'North Loop Cannabis');
    expect(mpls).toBeDefined();
    expect(mpls?.location.type).toBe('Point');
    expect(mpls?.location.coordinates).toHaveLength(2);
    expect(mpls?.deliveryPolygon.type).toBe('Polygon');
    expect(mpls?.deliveryPolygon.coordinates[0]?.length).toBeGreaterThanOrEqual(4);
  });

  it('seeds the full product catalog with category links', async () => {
    const pool = getPool();
    const products = new ProductsRepository(pool.db);
    const categories = new ProductCategoriesRepository(pool.db);

    const cats = await categories.listAll();
    expect(cats.length).toBeGreaterThanOrEqual(8);

    const flowerCat = cats.find((c) => c.slug === 'flower');
    expect(flowerCat).toBeDefined();
    const flowers = await products.listByCategory(flowerCat!.id);
    expect(flowers.length).toBeGreaterThan(0);
    for (const f of flowers) {
      expect(f.productType).toBe('flower');
    }
  });

  it('seeds dispensary listings with varied catalog per dispensary', async () => {
    const pool = getPool();
    const dispensaries = new DispensariesRepository(pool.db);
    const listings = new DispensaryListingsRepository(pool.db);

    const all = await dispensaries.listActive();
    const counts = await Promise.all(
      all.map(async (d) => ({
        dba: d.dba,
        count: (await listings.listForDispensary(d.id)).length,
      })),
    );
    const mpls = counts.find((c) => c.dba === 'North Loop Cannabis')!;
    const stp = counts.find((c) => c.dba === 'Capitol Cannabis')!;
    const mg = counts.find((c) => c.dba === 'The Grove')!;
    expect(mpls.count).toBeGreaterThan(0);
    expect(stp.count).toBeGreaterThan(0);
    expect(mg.count).toBeGreaterThan(0);
    // MPLS is the flagship in the seed — it should carry the widest catalog.
    expect(mpls.count).toBeGreaterThanOrEqual(stp.count);
    expect(mpls.count).toBeGreaterThanOrEqual(mg.count);
  });

  it('exposes empty repos for fixtures not exercised by the seed', async () => {
    const pool = getPool();
    const orders = new OrdersRepository(pool.db);
    const audit = new AuditLogRepository(pool.db);
    const notifications = new NotificationsRepository(pool.db);
    const compliance = new ComplianceChecksRepository(pool.db);
    const metrc = new MetrcTransactionsRepository(pool.db);
    const age = new AgeVerificationsRepository(pool.db);
    const cartItems = new CartItemsRepository(pool.db);
    const drivers = new DriversRepository(pool.db);
    const staff = new DispensaryStaffRepository(pool.db);
    const ledger = new LedgerEntriesRepository(pool.db);
    const payouts = new PayoutsRepository(pool.db);
    const payMethods = new PaymentMethodsRepository(pool.db);
    const pushTokens = new PushTokensRepository(pool.db);

    const aliceId = stableUuid('user', 'customer-1');
    const mplsId = stableUuid('dispensary', 'mpls');

    expect(await orders.listForUser(aliceId, 5)).toEqual([]);
    expect(await audit.listForActor(aliceId, 5)).toEqual([]);
    expect(await notifications.listForUser(aliceId, 5)).toEqual([]);
    expect(await compliance.listForSubject('order', aliceId, 5)).toEqual([]);
    expect(await metrc.listByStatus('pending', 5)).toEqual([]);
    expect(await age.listForUser(aliceId, 5)).toEqual([]);
    expect(await cartItems.listForCart(aliceId)).toEqual([]);
    expect(await drivers.listOnline()).toEqual([]);
    expect(await payouts.listByStatus('pending', 5)).toEqual([]);
    expect(await ledger.accountBalanceCents('platform_revenue', null)).toBe(0);
    expect(await pushTokens.listActiveForUser(aliceId)).toEqual([]);

    // Payment methods + dispensary staff ARE seeded, so just sanity-check.
    const aliceMethods = await payMethods.listForUser(aliceId);
    expect(Array.isArray(aliceMethods)).toBe(true);
    expect(aliceMethods.length).toBeGreaterThan(0);

    const mplsStaff = await staff.listActiveForDispensary(mplsId);
    expect(mplsStaff.length).toBeGreaterThan(0);
  });
});
