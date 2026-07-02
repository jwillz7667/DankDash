-- ============================================================================
-- DankDash — 0016_driver_aeropay_account
--
-- Adds the driver payout bank-account column — the driver-side analogue of
-- `dispensaries.aeropay_account_ref` (0000_init). A driver must have a linked
-- Aeropay bank account before either payout path can move money:
--
--   • instant cashout  — POST /v1/driver/cashout dispatches immediately when
--                         AEROPAY_LIVE=true; the live gateway reads this column
--                         and refuses (422) when it is NULL.
--   • nightly batch     — apps/workers payout job dispatches to drivers whose
--                         column is set and records the rest `pending`.
--
-- The value is the Aeropay bank-account id, written only by the
-- `bank_account.linked` webhook once a `driver:<userId>`-namespaced hosted
-- link completes (see DriverBankLinkService.applyBankLinked). It is Restricted
-- data (spec §8.1): the status surface exposes a boolean, never the ref.
--
-- Additive only: one nullable column with no default, no backfill, no RLS
-- change (the `drivers` table is app-layer tenant-scoped, not RLS-guarded).
-- Cutover risk = 0 — every existing driver row stays NULL and every current
-- query ignores the column.
-- ============================================================================

ALTER TABLE "drivers"
  ADD COLUMN "aeropay_account_ref" text;
