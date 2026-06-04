-- ============================================================================
-- DankDash — 0010_phase20_id_scan_idempotency
-- Phase 20 lights up the driver delivery flow, including the mandatory
-- Veriff ID scan at handoff. Two pieces of database hygiene are required:
--
-- 1. `age_verifications (provider, provider_session_id)` becomes UNIQUE.
--    The Veriff webhook receiver writes verification outcomes into
--    age_verifications. Veriff retries on 5xx and may deliver the same
--    event twice; the unique constraint guarantees the second insert is
--    a no-op (ON CONFLICT DO NOTHING in the repository). The composite
--    is the right grain — a `provider_session_id` is unique within a
--    provider but distinct providers (Persona for signup, Veriff for
--    handoff) may share session-id formats, so we don't impose
--    cross-provider uniqueness.
--
-- 2. A partial index on `orders.delivery_id_scan_ref` for the webhook
--    receiver to resolve an incoming verification back to the order.
--    The column is nullable and most orders never carry a value (only
--    delivered ones do), so the partial WHERE NOT NULL keeps the index
--    selective.
-- ============================================================================

ALTER TABLE "age_verifications"
  ADD CONSTRAINT "age_verifications_provider_session_unique"
  UNIQUE ("provider", "provider_session_id");
--> statement-breakpoint

CREATE INDEX "orders_delivery_id_scan_ref_idx"
  ON "orders" ("delivery_id_scan_ref")
  WHERE "delivery_id_scan_ref" IS NOT NULL;
