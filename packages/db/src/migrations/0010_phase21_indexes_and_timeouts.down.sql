-- Reverse of 0010_phase21_indexes_and_timeouts.

DROP INDEX IF EXISTS "orders_driver_status_placed_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "dispatch_offers_driver_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "payment_transactions_pending_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_unread_idx";
--> statement-breakpoint

ALTER TABLE "orders" RESET (
  autovacuum_vacuum_scale_factor,
  autovacuum_analyze_scale_factor
);
--> statement-breakpoint

ALTER TABLE "cart_items" RESET (
  autovacuum_vacuum_scale_factor,
  autovacuum_analyze_scale_factor
);
--> statement-breakpoint

DO $$
DECLARE
  leaf_oid oid;
  leaf_name text;
BEGIN
  FOR leaf_oid IN
    SELECT inhrelid FROM pg_inherits
    WHERE inhparent = 'public.order_events'::regclass
  LOOP
    SELECT format('%I.%I', n.nspname, c.relname)
      INTO leaf_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = leaf_oid;
    EXECUTE format(
      'ALTER TABLE %s RESET ('
      'autovacuum_vacuum_scale_factor, '
      'autovacuum_analyze_scale_factor)',
      leaf_name
    );
  END LOOP;
END$$;
--> statement-breakpoint

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I RESET statement_timeout', current_database());
  EXECUTE format('ALTER DATABASE %I RESET idle_in_transaction_session_timeout', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;
