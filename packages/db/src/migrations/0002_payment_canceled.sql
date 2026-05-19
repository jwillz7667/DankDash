-- ============================================================================
-- DankDash — 0002_payment_canceled
-- Adds 'canceled' to the payment_status enum so payment.canceled webhooks
-- from Aeropay can be persisted without coalescing into 'failed'.
--
-- Why the distinction matters: `failed` means the bank account rejected the
-- charge (NSF, frozen, etc.) and the order moves to `payment_failed`.
-- `canceled` means the payment never made it that far — typically a
-- customer-initiated abort during the Aeropay confirm step or an explicit
-- POST /v1/payments/:id/cancel from us. The downstream lifecycle hook in
-- PaymentMethodsService.handlePaymentCanceled keeps the order in `placed`
-- pending a separate cancellation flow rather than auto-transitioning to
-- `payment_failed`.
--
-- ADD VALUE inside an enum requires no table rewrite — existing rows are
-- untouched and any future INSERT/UPDATE can use the new label. The
-- `IF NOT EXISTS` guard makes the migration safely re-runnable in
-- environments that already received this DDL out-of-band.
-- ============================================================================

ALTER TYPE "public"."payment_status" ADD VALUE IF NOT EXISTS 'canceled' AFTER 'failed';
--> statement-breakpoint

-- canceled_at mirrors authorized_at / settled_at / failed_at so the lifecycle
-- timestamps stay symmetric. Nullable because pre-existing rows do not have
-- a canceled timestamp and never will (canceled is a forward-only state).
ALTER TABLE "payment_transactions"
  ADD COLUMN IF NOT EXISTS "canceled_at" timestamptz;
