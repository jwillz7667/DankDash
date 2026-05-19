-- ============================================================================
-- DankDash — 0005_order_status_history
-- Phase 7 (Order Lifecycle): adds the per-transition audit table and the
-- per-state timestamp columns the `OrderTransitionService` writes on every
-- status change.
--
-- `order_events` is the immutable event-stream (event_type as free text);
-- `order_status_history` is its tabular sibling that pins from_status,
-- to_status, and the actor, partitioned by month for cheap retention.
-- Both are written inside the same transaction as the `orders.status`
-- update so the audit trail can never disagree with current state.
--
-- The per-state timestamp columns on `orders` give us O(1) "how long has
-- this order been waiting on the driver" queries without joining the
-- history table; existing columns (placed_at, accepted_at, prepared_at,
-- picked_up_at, delivered_at, canceled_at) stay as-is. `prepared_at`
-- semantically means "vendor flipped to ready_for_pickup" — we keep it
-- under that historical name to avoid renaming a hot column.
-- ============================================================================

-- Per-state timestamps so the transition service can stamp the matching
-- column in the same UPDATE that flips `status`. All nullable; the row
-- has at most one of these set per state class.
ALTER TABLE "orders"
  ADD COLUMN "payment_failed_at"     timestamptz,
  ADD COLUMN "rejected_at"           timestamptz,
  ADD COLUMN "prepping_at"           timestamptz,
  ADD COLUMN "awaiting_driver_at"    timestamptz,
  ADD COLUMN "driver_assigned_at"    timestamptz,
  ADD COLUMN "en_route_pickup_at"    timestamptz,
  ADD COLUMN "en_route_dropoff_at"   timestamptz,
  ADD COLUMN "arrived_at_dropoff_at" timestamptz,
  ADD COLUMN "id_scan_pending_at"    timestamptz,
  ADD COLUMN "returned_to_store_at"  timestamptz,
  ADD COLUMN "disputed_at"           timestamptz,
  ADD COLUMN "rated_at"              timestamptz;
--> statement-breakpoint

-- Append-only, partitioned monthly on `changed_at`. PK includes the
-- partition key per Postgres' partitioned-table rule. The
-- `dankdash_block_mutation` trigger (defined in 0000_init.sql) is
-- re-applied below so UPDATE/DELETE on the table is rejected at the
-- DB tier even from the app role.
CREATE TABLE "order_status_history" (
  "id"           uuid NOT NULL DEFAULT gen_random_uuid(),
  "order_id"     uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "from_status"  "public"."order_status" NOT NULL,
  "to_status"    "public"."order_status" NOT NULL,
  "event_type"   text NOT NULL,
  "changed_by"   uuid REFERENCES "users"("id"),
  "actor_role"   text,
  "reason"       text,
  "changed_at"   timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("id","changed_at")
) PARTITION BY RANGE ("changed_at");
--> statement-breakpoint

CREATE INDEX "order_status_history_order_idx"
  ON "order_status_history" ("order_id","changed_at");
--> statement-breakpoint

CREATE TRIGGER order_status_history_no_update
  BEFORE UPDATE OR DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION dankdash_block_mutation();
--> statement-breakpoint

-- Bootstrap partitions for the current month and the next twelve. The
-- monthly cron in apps/workers will keep rolling new partitions forward,
-- but we seed a year up front so test environments and a cold-start
-- production deploy do not need the cron to have fired before the first
-- transition writes a row.
DO $$
DECLARE
  i           int;
  target_date date := date_trunc('month', NOW())::date;
BEGIN
  FOR i IN 0..12 LOOP
    PERFORM dankdash_create_month_partition(
      'order_status_history',
      EXTRACT(YEAR  FROM (target_date + (i || ' months')::interval))::int,
      EXTRACT(MONTH FROM (target_date + (i || ' months')::interval))::int
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- Extend the monthly partition cron's child-table list so future months
-- of `order_status_history` are created alongside `order_events`,
-- `notifications`, etc. The function body is replaced wholesale rather
-- than ALTER FUNCTION-patched so the table list stays trivially
-- reviewable in `git log -p`.
CREATE OR REPLACE FUNCTION dankdash_rollover_monthly_partitions()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_year  int;
  target_month int;
BEGIN
  target_year  := EXTRACT(YEAR  FROM (NOW() + interval '1 month'))::int;
  target_month := EXTRACT(MONTH FROM (NOW() + interval '1 month'))::int;

  PERFORM dankdash_create_month_partition('order_events',         target_year, target_month);
  PERFORM dankdash_create_month_partition('order_status_history', target_year, target_month);
  PERFORM dankdash_create_month_partition('notifications',        target_year, target_month);
  PERFORM dankdash_create_month_partition('audit_log',            target_year, target_month);
  PERFORM dankdash_create_month_partition(
    'driver_location_history', target_year, target_month
  );
END;
$$;
