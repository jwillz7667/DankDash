DROP FUNCTION IF EXISTS dankdash_rollover_monthly_partitions();

DROP TRIGGER IF EXISTS order_status_history_no_update ON "order_status_history";
DROP INDEX IF EXISTS "order_status_history_order_idx";
DROP TABLE IF EXISTS "order_status_history" CASCADE;

ALTER TABLE "orders"
  DROP COLUMN IF EXISTS "rated_at",
  DROP COLUMN IF EXISTS "disputed_at",
  DROP COLUMN IF EXISTS "returned_to_store_at",
  DROP COLUMN IF EXISTS "id_scan_pending_at",
  DROP COLUMN IF EXISTS "arrived_at_dropoff_at",
  DROP COLUMN IF EXISTS "en_route_dropoff_at",
  DROP COLUMN IF EXISTS "en_route_pickup_at",
  DROP COLUMN IF EXISTS "driver_assigned_at",
  DROP COLUMN IF EXISTS "awaiting_driver_at",
  DROP COLUMN IF EXISTS "prepping_at",
  DROP COLUMN IF EXISTS "rejected_at",
  DROP COLUMN IF EXISTS "payment_failed_at";
