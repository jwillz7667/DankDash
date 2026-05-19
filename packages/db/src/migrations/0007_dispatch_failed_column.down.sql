-- Restores the pre-0007 active-orders index (no `dispatch_failed` in the
-- exclusion list) and drops the timestamp column. The enum value itself
-- stays — see 0006.down for why.

DROP INDEX IF EXISTS "orders_active_idx";
--> statement-breakpoint

CREATE INDEX "orders_active_idx" ON "orders" ("placed_at")
  WHERE "status" NOT IN ('delivered','canceled','rejected');
--> statement-breakpoint

ALTER TABLE "orders" DROP COLUMN IF EXISTS "dispatch_failed_at";
