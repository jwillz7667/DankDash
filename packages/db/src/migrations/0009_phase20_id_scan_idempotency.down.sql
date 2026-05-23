DROP INDEX IF EXISTS "orders_delivery_id_scan_ref_idx";
ALTER TABLE "age_verifications"
  DROP CONSTRAINT IF EXISTS "age_verifications_provider_session_unique";
