-- ============================================================================
-- DankDash — 0006_dispatch_failed
-- Phase 8 (Dispatch & Driver Foundation): adds the `dispatch_failed` terminal
-- state to the order lifecycle. This is the state an order falls into when
-- the dispatch loop has cycled through every eligible driver and either
-- offered + timed out (default 30s each offer, 3min total) or found no
-- driver online in the dispensary's polygon at all.
--
-- The state is terminal — the spec (§3.3) says a dispatch failure escalates
-- to dispensary staff to either reschedule a fresh attempt (operationally a
-- new order) or refund the customer. We don't allow a transition back to
-- `awaiting_driver` because the dispatch attempt window is timestamped on
-- `dispatch_failed_at` and we want operator action to surface as a distinct
-- event rather than a silent retry.
--
-- ALTER TYPE ADD VALUE is allowed inside a tx in PG 12+ as long as the new
-- value is not used in the same transaction; we add the column referencing
-- the new value, but never INSERT a row using it here.
-- ============================================================================

ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'dispatch_failed' AFTER 'awaiting_driver';
--> statement-breakpoint

ALTER TABLE "orders" ADD COLUMN "dispatch_failed_at" timestamptz;
--> statement-breakpoint

-- The active-orders partial index excludes terminal states so the index
-- stays small. `dispatch_failed` is terminal, so widen the exclusion list
-- alongside the existing delivered/canceled/rejected set.
DROP INDEX IF EXISTS "orders_active_idx";
--> statement-breakpoint

CREATE INDEX "orders_active_idx" ON "orders" ("placed_at")
  WHERE "status" NOT IN ('delivered','canceled','rejected','dispatch_failed');
