-- ============================================================================
-- DankDash — 0007_dispatch_failed_column
-- Companion to 0006. Adds the `dispatch_failed_at` timestamp column on
-- `orders` and widens the active-orders partial index to exclude the new
-- terminal state, keeping that hot index small.
--
-- Split out of 0006 because Postgres refuses to use a newly-added enum
-- value inside the same transaction that added it. 0006 commits the
-- `dispatch_failed` enum value; 0007 references it once that commit is
-- visible to the catalog.
-- ============================================================================

ALTER TABLE "orders" ADD COLUMN "dispatch_failed_at" timestamptz;
--> statement-breakpoint

DROP INDEX IF EXISTS "orders_active_idx";
--> statement-breakpoint

CREATE INDEX "orders_active_idx" ON "orders" ("placed_at")
  WHERE "status" NOT IN ('delivered','canceled','rejected','dispatch_failed');
