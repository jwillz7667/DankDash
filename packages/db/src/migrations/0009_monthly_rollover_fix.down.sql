-- Restore the 0005 definition of dankdash_rollover_monthly_partitions():
-- a single-next-month rollover that also (incorrectly) tried to create a
-- monthly partition for the week-partitioned driver_location_history.
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
