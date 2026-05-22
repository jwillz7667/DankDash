/**
 * Phase 21 — verifies migration `0006_phase21_indexes_and_timeouts` produced
 * what we said it would. These are schema-introspection tests: they ask
 * Postgres whether the expected indexes exist with the expected predicates,
 * not "does an end-user query use them" (that's the EXPLAIN appendix work
 * captured in `docs/runbooks/load-test-execution.md`).
 *
 * If anyone edits the migration and accidentally drops a predicate or
 * changes a column, this catches it before staging.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getPool } from '../setup.js';

interface IndexRow {
  readonly indexname: string;
  readonly indexdef: string;
}

async function indexDef(name: string): Promise<IndexRow | undefined> {
  const pool = getPool();
  const rows = (await pool.db.execute(
    sql.raw(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = '${name}'
  `),
  )) as unknown as ReadonlyArray<IndexRow>;
  return rows[0];
}

describe('migration 0006 — additive indexes', () => {
  it('orders_driver_status_placed_idx covers (driver_id, status, placed_at DESC) WHERE driver_id IS NOT NULL', async () => {
    const row = await indexDef('orders_driver_status_placed_idx');
    expect(row).toBeDefined();
    expect(row?.indexdef).toMatch(/\(driver_id, status, placed_at DESC\)/);
    expect(row?.indexdef).toMatch(/WHERE \(driver_id IS NOT NULL\)/);
  });

  it('dispatch_offers_driver_status_idx covers (driver_id, status, offered_at DESC)', async () => {
    const row = await indexDef('dispatch_offers_driver_status_idx');
    expect(row).toBeDefined();
    expect(row?.indexdef).toMatch(/\(driver_id, status, offered_at DESC\)/);
  });

  it('payment_transactions_pending_idx is partial on initiated/authorized', async () => {
    const row = await indexDef('payment_transactions_pending_idx');
    expect(row).toBeDefined();
    expect(row?.indexdef).toMatch(/\(initiated_at\)/);
    // pg's index defn re-renders the IN list as a multi-OR ANY array; either
    // representation is fine, but both terms must appear.
    expect(row?.indexdef).toMatch(/initiated/);
    expect(row?.indexdef).toMatch(/authorized/);
  });

  it('notifications_unread_idx is partial WHERE read_at IS NULL', async () => {
    const row = await indexDef('notifications_unread_idx');
    expect(row).toBeDefined();
    expect(row?.indexdef).toMatch(/WHERE \(read_at IS NULL\)/);
  });
});

describe('migration 0006 — autovacuum tuning', () => {
  async function reloptions(relname: string): Promise<readonly string[]> {
    const pool = getPool();
    const rows = (await pool.db.execute(
      sql.raw(`
      SELECT COALESCE(reloptions, ARRAY[]::text[]) AS reloptions
        FROM pg_class
       WHERE relname = '${relname}'
         AND relnamespace = 'public'::regnamespace
    `),
    )) as unknown as ReadonlyArray<{ reloptions: readonly string[] }>;
    return rows[0]?.reloptions ?? [];
  }

  it('orders has the tuned autovacuum_vacuum_scale_factor', async () => {
    const opts = await reloptions('orders');
    expect(opts).toContain('autovacuum_vacuum_scale_factor=0.05');
    expect(opts).toContain('autovacuum_analyze_scale_factor=0.05');
  });

  it('cart_items has the tuned autovacuum_vacuum_scale_factor', async () => {
    const opts = await reloptions('cart_items');
    expect(opts).toContain('autovacuum_vacuum_scale_factor=0.05');
    expect(opts).toContain('autovacuum_analyze_scale_factor=0.05');
  });

  it('all order_events leaf partitions inherit the tuned thresholds', async () => {
    const pool = getPool();
    const rows = (await pool.db.execute(
      sql.raw(`
      SELECT c.relname,
             COALESCE(c.reloptions, ARRAY[]::text[]) AS reloptions
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'public.order_events'::regclass
       ORDER BY c.relname
    `),
    )) as unknown as ReadonlyArray<{
      readonly relname: string;
      readonly reloptions: readonly string[];
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.reloptions, `partition ${row.relname} missing reloptions`).toContain(
        'autovacuum_vacuum_scale_factor=0.05',
      );
      expect(row.reloptions).toContain('autovacuum_analyze_scale_factor=0.05');
    }
  });
});

describe('migration 0006 — connection-level timeouts', () => {
  it('statement_timeout is set on every new connection from the pool', async () => {
    const pool = getPool();
    const rows = (await pool.db.execute(
      sql.raw(`
      SELECT current_setting('statement_timeout') AS value
    `),
    )) as unknown as ReadonlyArray<{ value: string }>;
    // Pool default is 30000ms (30s) — postgres-js applies it via the
    // libpq startup-parameters path, and pg renders 30000ms as "30s".
    expect(rows[0]?.value).toBe('30s');
  });

  it('idle_in_transaction_session_timeout is set on every new connection', async () => {
    const pool = getPool();
    const rows = (await pool.db.execute(
      sql.raw(`
      SELECT current_setting('idle_in_transaction_session_timeout') AS value
    `),
    )) as unknown as ReadonlyArray<{ value: string }>;
    expect(rows[0]?.value).toBe('1min');
  });
});
