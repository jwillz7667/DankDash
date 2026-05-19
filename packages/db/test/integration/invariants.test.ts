/**
 * Schema-level invariants enforced by the database itself: triggers, CHECK
 * constraints, append-only guards. The repository layer assumes these hold,
 * so if any of these tests fail the rest of the app is unsafe.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuditLogRepository,
  LedgerEntriesRepository,
  OrderEventsRepository,
  ProductCategoriesRepository,
  ProductsRepository,
  stableUuid,
  UsersRepository,
} from '../../src/index.js';
import { getPool, seedDefault } from '../setup.js';

describe('schema invariants', () => {
  beforeAll(async () => {
    await seedDefault();
  }, 60_000);

  describe('updated_at trigger', () => {
    it('bumps users.updated_at on UPDATE', async () => {
      const pool = getPool();
      const users = new UsersRepository(pool.db);
      const aliceId = stableUuid('user', 'customer-1');

      const before = await users.findById(aliceId);
      expect(before).not.toBeNull();
      const tsBefore = before!.updatedAt.getTime();

      // Ensure the system clock advances at least 1ms — Postgres NOW() has
      // microsecond resolution but the JS Date roundtrip is millisecond.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const updated = await users.update(aliceId, { firstName: 'AliceUpdated' });
      expect(updated).not.toBeNull();
      const after = await users.findById(aliceId);
      expect(after!.updatedAt.getTime()).toBeGreaterThan(tsBefore);
      expect(after!.firstName).toBe('AliceUpdated');
    });
  });

  describe('products.search_vector', () => {
    it('populates search_vector on insert from name+brand+description', async () => {
      const pool = getPool();
      const categories = new ProductCategoriesRepository(pool.db);
      const products = new ProductsRepository(pool.db);

      const cats = await categories.listAll();
      const flowerCat = cats.find((c) => c.slug === 'flower')!;

      const inserted = await products.create({
        categoryId: flowerCat.id,
        brand: 'TestSearchBrand',
        name: 'Cosmic Funk Indica 14g',
        description: 'Smooth earthy nose with citrus finish',
        productType: 'flower',
        strainType: 'indica',
        thcMgPerUnit: '2100.000',
        weightGramsPerUnit: '14.000',
        isActive: true,
      });

      // Search vector is set by an INSERT trigger — read it back via raw SQL.
      const [row] = await pool.sql<
        { search_vector_text: string | null }[]
      >`SELECT search_vector::text AS search_vector_text FROM products WHERE id = ${inserted.id}`;

      expect(row?.search_vector_text).toBeDefined();
      const text = row?.search_vector_text ?? '';
      expect(text).toContain('cosmic');
      expect(text).toContain('funk');
      expect(text).toContain('testsearchbrand');
      // 'earthy' comes from description, which is weighted C.
      expect(text).toContain('earthi'); // ts_vector stems to 'earthi'
    });
  });

  describe('beverage 10mg-per-serving CHECK constraint', () => {
    it('rejects a beverage product with thc_mg_per_serving > 10', async () => {
      const pool = getPool();
      const categories = new ProductCategoriesRepository(pool.db);
      const cats = await categories.listAll();
      const bevCat = cats.find((c) => c.slug === 'beverages')!;
      expect(bevCat).toBeDefined();

      await expect(
        pool.sql`
          INSERT INTO products (
            category_id, brand, name, product_type,
            thc_mg_per_unit, thc_mg_per_serving, serving_count, is_active
          )
          VALUES (
            ${bevCat.id}, 'Bad Bev Co', 'Overdose 12oz', 'beverage',
            25, 25, 1, true
          )
        `,
      ).rejects.toThrow(/products_beverage_potency_cap/);
    });

    it('rejects a beverage with more than 2 servings per container', async () => {
      const pool = getPool();
      const categories = new ProductCategoriesRepository(pool.db);
      const cats = await categories.listAll();
      const bevCat = cats.find((c) => c.slug === 'beverages')!;

      await expect(
        pool.sql`
          INSERT INTO products (
            category_id, brand, name, product_type,
            thc_mg_per_unit, thc_mg_per_serving, serving_count, is_active
          )
          VALUES (
            ${bevCat.id}, 'Bad Bev Co', 'Multipack 32oz', 'beverage',
            30, 10, 3, true
          )
        `,
      ).rejects.toThrow(/products_beverage_serving_cap/);
    });

    it('accepts a compliant beverage (exactly 10mg/serving, 2 servings)', async () => {
      const pool = getPool();
      const products = new ProductsRepository(pool.db);
      const categories = new ProductCategoriesRepository(pool.db);
      const cats = await categories.listAll();
      const bevCat = cats.find((c) => c.slug === 'beverages')!;

      const row = await products.create({
        categoryId: bevCat.id,
        brand: 'Compliant Co',
        name: 'Limit Edge 12oz',
        productType: 'beverage',
        thcMgPerUnit: '20.000',
        thcMgPerServing: '10.000',
        servingCount: 2,
        isActive: true,
      });
      expect(row.thcMgPerServing).toBe('10.000');
      expect(row.servingCount).toBe(2);
    });
  });

  describe('append-only enforcement', () => {
    it('rejects UPDATE and DELETE on order_events', async () => {
      const pool = getPool();
      const events = new OrderEventsRepository(pool.db);

      // Need a real order to attach an event to. Build it via raw SQL using
      // seeded foreign keys — routing through the orders repo would distract
      // from what this test is actually proving.
      const aliceId = stableUuid('user', 'customer-1');
      const dispensaryId = stableUuid('dispensary', 'mpls');
      const addressId = stableUuid('address', 'addr-alice-home');

      const shortCode = `TEST${Math.floor(Math.random() * 1_000_000)}`;
      const [order] = await pool.sql<{ id: string }[]>`
        INSERT INTO orders (
          short_code, user_id, dispensary_id, delivery_address_id,
          subtotal_cents, cannabis_tax_cents, sales_tax_cents,
          delivery_fee_cents, total_cents,
          compliance_check_payload, delivery_address_snapshot
        )
        VALUES (
          ${shortCode}, ${aliceId}, ${dispensaryId}, ${addressId},
          1000, 100, 100, 0, 1200,
          '{}'::jsonb, '{}'::jsonb
        )
        RETURNING id
      `;
      expect(order).toBeDefined();

      const event = await events.record({
        orderId: order!.id,
        eventType: 'order.placed',
        payload: { source: 'test' },
      });

      await expect(
        pool.sql`UPDATE order_events SET event_type = 'changed' WHERE id = ${event.id}`,
      ).rejects.toThrow(/append-only/);

      await expect(pool.sql`DELETE FROM order_events WHERE id = ${event.id}`).rejects.toThrow(
        /append-only/,
      );
    });

    it('rejects UPDATE and DELETE on ledger_entries', async () => {
      const pool = getPool();
      const ledger = new LedgerEntriesRepository(pool.db);

      const entries = await ledger.recordTransaction([
        {
          accountType: 'platform_revenue',
          accountRef: null,
          debitCents: 500,
          creditCents: 0,
          description: 'invariant test debit',
        },
        {
          accountType: 'aeropay_clearing',
          accountRef: null,
          debitCents: 0,
          creditCents: 500,
          description: 'invariant test credit',
        },
      ]);
      expect(entries.length).toBe(2);

      await expect(
        pool.sql`UPDATE ledger_entries SET description = 'tamper' WHERE id = ${entries[0]!.id}`,
      ).rejects.toThrow(/append-only/);

      await expect(
        pool.sql`DELETE FROM ledger_entries WHERE id = ${entries[0]!.id}`,
      ).rejects.toThrow(/append-only/);
    });

    it('rejects UPDATE and DELETE on audit_log', async () => {
      const pool = getPool();
      const audit = new AuditLogRepository(pool.db);
      const aliceId = stableUuid('user', 'customer-1');

      const entry = await audit.record({
        actorUserId: aliceId,
        actorRole: 'consumer',
        action: 'test.action',
        resourceType: 'invariant-test',
        resourceId: 'inv-001',
        changes: { hello: 'world' },
      });

      await expect(
        pool.sql`UPDATE audit_log SET action = 'tamper' WHERE id = ${entry.id}`,
      ).rejects.toThrow(/append-only/);

      await expect(pool.sql`DELETE FROM audit_log WHERE id = ${entry.id}`).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('LedgerEntriesRepository.recordTransaction', () => {
    it('rejects unbalanced double-entry input before touching the DB', async () => {
      const pool = getPool();
      const ledger = new LedgerEntriesRepository(pool.db);

      await expect(
        ledger.recordTransaction([
          {
            accountType: 'platform_revenue',
            accountRef: null,
            debitCents: 100,
            creditCents: 0,
            description: 'unbalanced debit',
          },
          {
            accountType: 'aeropay_clearing',
            accountRef: null,
            debitCents: 0,
            creditCents: 50, // mismatched on purpose
            description: 'unbalanced credit',
          },
        ]),
      ).rejects.toThrow(/unbalanced ledger/);
    });

    it('rejects empty input', async () => {
      const pool = getPool();
      const ledger = new LedgerEntriesRepository(pool.db);
      await expect(ledger.recordTransaction([])).rejects.toThrow(/at least one entry/);
    });
  });
});
