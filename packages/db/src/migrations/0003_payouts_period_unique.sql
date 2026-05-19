-- ============================================================================
-- DankDash — 0003_payouts_period_unique
-- Adds a UNIQUE constraint on (recipient_type, recipient_id, period_start,
-- period_end) so the daily payout job is idempotent: a second run for the
-- same calendar day on the same recipient is a no-op (ON CONFLICT DO NOTHING
-- in the insert path), not a duplicate row.
--
-- Why this matters operationally: the job is scheduled via node-cron in
-- apps/workers, but a redeploy or a Railway worker restart shortly after
-- 03:00 Central could fire the trigger twice. Without the constraint, both
-- runs would create payout rows and both would call Aeropay createPayout —
-- the Aeropay idempotency key (`payout:<id>`) would protect the upstream
-- charge, but we'd still have duplicate rows in our own ledger and a
-- confusing reconciliation surface. The unique constraint pushes the
-- guarantee down to the DB where it belongs.
--
-- The existing payouts_recipient_idx covers (recipient_type, recipient_id,
-- period_end DESC) but that's a plain B-tree on a different prefix; the
-- new unique uses period_start AND period_end and is therefore additive.
-- ============================================================================

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_recipient_period_uq"
  UNIQUE ("recipient_type", "recipient_id", "period_start", "period_end");
