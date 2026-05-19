-- ============================================================================
-- DankDash — 0004_webhook_events_processed
-- Creates the idempotency table that guarantees a webhook delivery from
-- Aeropay (or any future provider) is processed at most once. The
-- AeropayWebhookController inserts the row before applying side effects;
-- a primary-key conflict means we've already handled this `event_id` and
-- the request is short-circuited to a 204.
--
-- TTL: rows are retained for 30 days from receipt so an Aeropay retry storm
-- (their backoff window is 72 hours) is always covered, with comfortable
-- slack for human-driven re-replays during an incident. A nightly cron in
-- apps/workers purges expired rows; the expires_at index keeps that
-- DELETE selective rather than a full scan.
--
-- The composite `(provider, event_id)` would be more general, but Aeropay
-- guarantees globally-unique event ids and the only producer today is
-- Aeropay. Keeping `event_id` as the bare PK keeps the lookup O(1) on a
-- single column and avoids a second index for the dedup probe; the
-- `provider` column is still recorded for observability and to make a
-- future second provider a column-default migration rather than a PK
-- redefinition.
-- ============================================================================

CREATE TABLE "webhook_events_processed" (
  "event_id" TEXT PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint

CREATE INDEX "webhook_events_processed_expires_at_idx"
  ON "webhook_events_processed" ("expires_at");
