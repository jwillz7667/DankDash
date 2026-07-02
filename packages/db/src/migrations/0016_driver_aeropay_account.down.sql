-- Rollback 0016_driver_aeropay_account.
ALTER TABLE "drivers"
  DROP COLUMN IF EXISTS "aeropay_account_ref";
