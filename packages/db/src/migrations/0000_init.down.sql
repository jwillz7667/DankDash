-- ============================================================================
-- DankDash — 0000_init (down)
-- Reverses 0000_init.sql. Drops all tables (CASCADE handles partitions,
-- triggers, indexes, policies, FKs), then enum types, then functions, then
-- the app_vendor role. Extensions stay installed: they are cluster-wide and
-- dropping them can affect other databases on the same server.
--
-- Order is reverse of creation so cross-references resolve without surprise,
-- though CASCADE makes order non-load-bearing.
-- ============================================================================

-- Append-only triggers (auto-dropped with tables; explicit DROP keeps reruns
-- safe if something hand-creates partial state during dev iteration).
DROP TRIGGER IF EXISTS audit_log_no_update     ON "audit_log";
DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";
DROP TRIGGER IF EXISTS order_events_no_update   ON "order_events";
--> statement-breakpoint

-- RLS policies (also auto-dropped with tables, but DROP POLICY IF EXISTS is
-- idempotent and lets a partial down/up cycle recover cleanly).
DROP POLICY IF EXISTS ptx_vendor_isolation       ON "payment_transactions";
DROP POLICY IF EXISTS payouts_vendor_isolation   ON "payouts";
DROP POLICY IF EXISTS staff_vendor_isolation     ON "dispensary_staff";
DROP POLICY IF EXISTS listings_vendor_isolation  ON "dispensary_listings";
DROP POLICY IF EXISTS order_items_vendor_isolation ON "order_items";
DROP POLICY IF EXISTS orders_vendor_isolation    ON "orders";
--> statement-breakpoint

-- Drop tables. Partitioned parents (notifications, order_events,
-- driver_location_history, audit_log) take their partitions with them.
DROP TABLE IF EXISTS "audit_log"               CASCADE;
DROP TABLE IF EXISTS "push_tokens"             CASCADE;
DROP TABLE IF EXISTS "notifications"           CASCADE;
DROP TABLE IF EXISTS "age_verifications"       CASCADE;
DROP TABLE IF EXISTS "metrc_transactions"      CASCADE;
DROP TABLE IF EXISTS "compliance_checks"       CASCADE;
DROP TABLE IF EXISTS "dispatch_offers"         CASCADE;
DROP TABLE IF EXISTS "driver_location_history" CASCADE;
DROP TABLE IF EXISTS "driver_shifts"           CASCADE;
DROP TABLE IF EXISTS "drivers"                 CASCADE;
DROP TABLE IF EXISTS "refunds"                 CASCADE;
DROP TABLE IF EXISTS "payouts"                 CASCADE;
DROP TABLE IF EXISTS "ledger_entries"          CASCADE;
DROP TABLE IF EXISTS "payment_transactions"    CASCADE;
DROP TABLE IF EXISTS "payment_methods"         CASCADE;
DROP TABLE IF EXISTS "order_events"            CASCADE;
DROP TABLE IF EXISTS "order_items"             CASCADE;
DROP TABLE IF EXISTS "orders"                  CASCADE;
DROP TABLE IF EXISTS "cart_items"              CASCADE;
DROP TABLE IF EXISTS "carts"                   CASCADE;
DROP TABLE IF EXISTS "product_lab_results"     CASCADE;
DROP TABLE IF EXISTS "dispensary_listings"     CASCADE;
DROP TABLE IF EXISTS "products"                CASCADE;
DROP TABLE IF EXISTS "product_categories"      CASCADE;
DROP TABLE IF EXISTS "dispensary_staff"        CASCADE;
DROP TABLE IF EXISTS "dispensaries"            CASCADE;
DROP TABLE IF EXISTS "sessions"                CASCADE;
DROP TABLE IF EXISTS "user_id_documents"       CASCADE;
DROP TABLE IF EXISTS "user_addresses"          CASCADE;
DROP TABLE IF EXISTS "users"                   CASCADE;
--> statement-breakpoint

-- Functions installed by 0000_init.
DROP FUNCTION IF EXISTS dankdash_block_mutation()                                 CASCADE;
DROP FUNCTION IF EXISTS dankdash_create_week_partition(text, date)                CASCADE;
DROP FUNCTION IF EXISTS dankdash_create_month_partition(text, integer, integer)   CASCADE;
DROP FUNCTION IF EXISTS products_search_vector_update()                           CASCADE;
DROP FUNCTION IF EXISTS set_updated_at()                                          CASCADE;
--> statement-breakpoint

-- Enum types.
DROP TYPE IF EXISTS "public"."notification_channel"  CASCADE;
DROP TYPE IF EXISTS "public"."verification_context"  CASCADE;
DROP TYPE IF EXISTS "public"."metrc_status"          CASCADE;
DROP TYPE IF EXISTS "public"."compliance_check_type" CASCADE;
DROP TYPE IF EXISTS "public"."offer_status"          CASCADE;
DROP TYPE IF EXISTS "public"."driver_status"         CASCADE;
DROP TYPE IF EXISTS "public"."refund_status"         CASCADE;
DROP TYPE IF EXISTS "public"."payout_status"         CASCADE;
DROP TYPE IF EXISTS "public"."payout_recipient"      CASCADE;
DROP TYPE IF EXISTS "public"."ledger_account_type"   CASCADE;
DROP TYPE IF EXISTS "public"."payment_status"        CASCADE;
DROP TYPE IF EXISTS "public"."payment_method_status" CASCADE;
DROP TYPE IF EXISTS "public"."payment_method_type"   CASCADE;
DROP TYPE IF EXISTS "public"."order_status"          CASCADE;
DROP TYPE IF EXISTS "public"."strain_type"           CASCADE;
DROP TYPE IF EXISTS "public"."product_type"          CASCADE;
DROP TYPE IF EXISTS "public"."staff_role"            CASCADE;
DROP TYPE IF EXISTS "public"."pos_provider"          CASCADE;
DROP TYPE IF EXISTS "public"."dispensary_status"     CASCADE;
DROP TYPE IF EXISTS "public"."license_type"          CASCADE;
DROP TYPE IF EXISTS "public"."id_document_type"      CASCADE;
DROP TYPE IF EXISTS "public"."user_status"           CASCADE;
DROP TYPE IF EXISTS "public"."user_role"             CASCADE;
--> statement-breakpoint

-- App role last, after every object it owned/used is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_vendor') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM app_vendor;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_vendor;
    REVOKE ALL ON SCHEMA public                  FROM app_vendor;
    DROP ROLE app_vendor;
  END IF;
END$$;
