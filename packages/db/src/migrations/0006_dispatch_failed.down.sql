-- ALTER TYPE ... DROP VALUE does not exist in Postgres; we cannot remove the
-- 'dispatch_failed' enum value once added. The rollback restores the original
-- active-orders index and drops the timestamp column; production rollback of
-- the enum widening must be handled by a forward-fix migration that maps
-- existing rows back into `awaiting_driver`.

DROP INDEX IF EXISTS "orders_active_idx";
CREATE INDEX "orders_active_idx" ON "orders" ("placed_at")
  WHERE "status" NOT IN ('delivered','canceled','rejected');

ALTER TABLE "orders" DROP COLUMN IF EXISTS "dispatch_failed_at";
