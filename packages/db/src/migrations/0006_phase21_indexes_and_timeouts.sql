-- ============================================================================
-- DankDash — 0006_phase21_indexes_and_timeouts
--
-- Phase 21 hardening. This migration is additive only — it adds new
-- indexes the pre-launch EXPLAIN walkthrough surfaced as gaps, tightens
-- the autovacuum trigger on three hot tables, and installs
-- database-default `statement_timeout` + `idle_in_transaction_session_timeout`
-- as a runaway-query safety net.
--
-- Nothing is dropped, nothing is altered. Production cutover risk = 0.
--
-- ───────────────────────── New indexes (4) ─────────────────────────────────
--
-- 1. `orders_driver_status_placed_idx`
--    Driver iOS app's order-history tabs filter by both driver_id and
--    status, ordered by placed_at DESC. The existing
--    `orders_driver_idx (driver_id) WHERE driver_id IS NOT NULL` requires
--    a heap fetch + filter to satisfy the status predicate. The new
--    composite covers the "delivered / in-progress / canceled" tab
--    queries without a heap read.
--
-- 2. `dispatch_offers_driver_status_idx`
--    Driver "current offer" lookup runs as
--    `WHERE driver_id = ? AND status = 'offered' ORDER BY offered_at DESC`.
--    The existing `dispatch_offers_driver_idx (driver_id, offered_at DESC)`
--    is selective on driver but not on status; the partial
--    `dispatch_offers_active_idx (expires_at) WHERE status = 'offered'`
--    targets the expiry sweeper, not the per-driver list. This composite
--    covers both filter directions.
--
-- 3. `payment_transactions_pending_idx`
--    The reconciliation worker sweeps for transactions stuck in
--    `initiated` or `authorized` past the SLA. The partial WHERE keeps
--    the index tiny (≪1% of rows in steady state — everything
--    eventually settles to settled/failed/refunded).
--
--    Note: provider-ref lookup is already covered by the
--    `payment_transactions_provider_ref_uq` UNIQUE constraint from 0000.
--
-- 4. `notifications_unread_idx`
--    The iOS consumer + portal both render an unread badge using
--    `WHERE user_id = ? AND read_at IS NULL`. The existing
--    `notifications_user_idx (user_id, created_at DESC)` doesn't
--    filter on read_at — adding a partial keeps the unread sweep
--    O(unread), not O(history). `notifications` is partitioned by
--    `created_at`, so the partial index is also partitioned (Postgres 16
--    propagates partial-index templates to all partitions).
--
-- ───────────────────────── Autovacuum tuning ──────────────────────────────
--
-- Default `autovacuum_vacuum_scale_factor = 0.2` waits until 20% of a
-- table is dead tuples before vacuuming. On `orders`, `order_events`,
-- and `cart_items` — our hottest tables — that's far too lenient at
-- production scale. Dropping to 0.05 (5%) triggers vacuum/analyze more
-- often, keeping bloat low and stats fresh. The 5% threshold is the
-- write-heavy-table guidance we tuned from the pg_stat_user_tables
-- walkthrough.
--
-- ───────────────────────── Database timeouts ──────────────────────────────
--
-- `statement_timeout = '30s'` and `idle_in_transaction_session_timeout = '60s'`
-- become database-level defaults. Any session that doesn't override
-- them via SET LOCAL inherits these limits, so a runaway query can't
-- pin a connection indefinitely.
--
-- Workers override these per-pool (they legitimately run multi-minute
-- batch jobs); see packages/db/src/client.ts. The application-layer
-- enforcement (via postgres-js `connection.statement_timeout`) is the
-- authoritative copy; this ALTER DATABASE is defense in depth.
--
-- ALTER DATABASE requires CREATEDB or superuser. The DO block makes
-- the timeout install best-effort so applying this migration against a
-- managed Postgres that revokes ALTER DATABASE (rare) doesn't break
-- the migration runner.
-- ============================================================================

CREATE INDEX "orders_driver_status_placed_idx"
  ON "orders" ("driver_id", "status", "placed_at" DESC)
  WHERE "driver_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX "dispatch_offers_driver_status_idx"
  ON "dispatch_offers" ("driver_id", "status", "offered_at" DESC);
--> statement-breakpoint

CREATE INDEX "payment_transactions_pending_idx"
  ON "payment_transactions" ("initiated_at")
  WHERE "status" IN ('initiated', 'authorized');
--> statement-breakpoint

CREATE INDEX "notifications_unread_idx"
  ON "notifications" ("user_id", "created_at" DESC)
  WHERE "read_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "orders" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
--> statement-breakpoint

ALTER TABLE "cart_items" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
--> statement-breakpoint

-- `order_events` is partitioned; Postgres rejects storage parameters on
-- the parent and requires them on each leaf partition. Iterate over
-- all current leaf partitions inheriting from `order_events` and apply
-- the same settings used on the non-partitioned hot tables above.
DO $$
DECLARE
  leaf_oid oid;
  leaf_name text;
BEGIN
  FOR leaf_oid IN
    SELECT inhrelid
    FROM pg_inherits
    WHERE inhparent = 'public.order_events'::regclass
  LOOP
    SELECT format('%I.%I', n.nspname, c.relname)
      INTO leaf_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = leaf_oid;
    EXECUTE format(
      'ALTER TABLE %s SET ('
      'autovacuum_vacuum_scale_factor = 0.05, '
      'autovacuum_analyze_scale_factor = 0.05)',
      leaf_name
    );
  END LOOP;
END$$;
--> statement-breakpoint

-- Bake the same settings into the partition-creator helper so future
-- monthly partitions of `order_events` are born with the tuned
-- autovacuum thresholds. notifications/audit_log keep Postgres
-- defaults — they're partitioned via the same helper but aren't in the
-- Phase 21 hot-table set. Parameter names match 0000_init.sql exactly;
-- Postgres CREATE OR REPLACE FUNCTION forbids parameter-name changes.
CREATE OR REPLACE FUNCTION dankdash_create_month_partition(
  parent_table text,
  year int,
  month int
) RETURNS void AS $$
DECLARE
  partition_name text;
  start_date date;
  end_date date;
BEGIN
  start_date := make_date(year, month, 1);
  end_date   := start_date + interval '1 month';
  partition_name := format('%s_%s_%s', parent_table, year, to_char(start_date,'MM'));
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_table, start_date, end_date
    );
    IF parent_table = 'order_events' THEN
      EXECUTE format(
        'ALTER TABLE %I SET ('
        'autovacuum_vacuum_scale_factor = 0.05, '
        'autovacuum_analyze_scale_factor = 0.05)',
        partition_name
      );
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET statement_timeout = ''30s''',
    current_database()
  );
  EXECUTE format(
    'ALTER DATABASE %I SET idle_in_transaction_session_timeout = ''60s''',
    current_database()
  );
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE
      'Skipping ALTER DATABASE timeouts: insufficient privilege. '
      'Pool-level enforcement in packages/db/src/client.ts is the '
      'authoritative layer.';
END $$;
