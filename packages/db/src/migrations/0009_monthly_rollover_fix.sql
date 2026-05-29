-- ============================================================================
-- DankDash — 0009_monthly_rollover_fix
-- ----------------------------------------------------------------------------
-- Corrects dankdash_rollover_monthly_partitions(), the maintenance function
-- that keeps the monthly-partitioned append-only tables (order_events,
-- order_status_history, notifications, audit_log) ahead of the write horizon.
-- Two defects are fixed:
--
--   1. The function also called dankdash_create_month_partition() for
--      driver_location_history, which is WEEKLY-partitioned (see 0000_init.sql).
--      A monthly bound overlaps the weekly partitions, so any invocation would
--      raise "partition ... would overlap partition". driver_location_history
--      has its own weekly lifecycle job and is removed from this function.
--
--   2. The function created only the SINGLE next month. With the daily cron
--      now wired in apps/workers, a brief worker outage could let the horizon
--      collapse toward the current month. It now ensures the current month
--      plus the next three exist, so a multi-week outage self-heals on the
--      next successful run. Every create stays idempotent via
--      dankdash_create_month_partition's IF NOT EXISTS guard.
--
-- Before this change set the function had no runtime caller at all — the
-- worker that should invoke it was never scheduled, making the bootstrap
-- runway (~13-14 months) a hard time-bomb for the order lifecycle. The
-- monthly-partition-rollover job added alongside this migration invokes it
-- daily (and on worker boot).
-- ============================================================================
CREATE OR REPLACE FUNCTION dankdash_rollover_monthly_partitions()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  month_offset int;
  target_date  date;
  target_year  int;
  target_month int;
BEGIN
  -- Current month (self-heal) through three months ahead. driver_location_history
  -- is intentionally absent: it is week-partitioned and owned by the weekly job.
  FOR month_offset IN 0..3 LOOP
    target_date  := (date_trunc('month', NOW()) + (month_offset || ' months')::interval)::date;
    target_year  := EXTRACT(YEAR  FROM target_date)::int;
    target_month := EXTRACT(MONTH FROM target_date)::int;

    PERFORM dankdash_create_month_partition('order_events',         target_year, target_month);
    PERFORM dankdash_create_month_partition('order_status_history', target_year, target_month);
    PERFORM dankdash_create_month_partition('notifications',        target_year, target_month);
    PERFORM dankdash_create_month_partition('audit_log',            target_year, target_month);
  END LOOP;
END;
$$;
