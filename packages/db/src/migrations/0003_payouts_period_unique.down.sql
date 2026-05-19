-- ============================================================================
-- DankDash — 0003_payouts_period_unique (down)
-- Removes the uniqueness constraint added in the up migration. Safe to run
-- unconditionally; no data is touched.
-- ============================================================================

ALTER TABLE "payouts"
  DROP CONSTRAINT IF EXISTS "payouts_recipient_period_uq";
