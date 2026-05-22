-- ============================================================================
-- DankDash — 0008_metrc_next_retry
-- Phase 11 (Metrc Traceability): adds `next_retry_at` to
-- `metrc_transactions` and reshapes the partial index so the reporting
-- worker can drive exponential backoff entirely from a SQL polling
-- query.
--
-- Why no BullMQ: the only producer is the `order.delivered` event, the
-- only consumer is the Metrc reporting worker, and the backoff is a
-- fixed 6-step schedule (1m, 5m, 15m, 1h, 6h, 24h) per
-- DankDash-Technical-Spec.md §7.2. A single bigint column + a partial
-- index gives us the same delivery + retry semantics without dragging a
-- second queue runtime into the workers process.
--
-- `next_retry_at` defaults to `NOW()` so a freshly-inserted row is
-- immediately due — the worker can pick it up on the next cron tick
-- without a separate "schedule first attempt" code path.
--
-- The new `metrc_transactions_due_idx` is a partial index over the
-- worker's hot query — `WHERE status = 'pending' AND next_retry_at <=
-- NOW()`. Excluding `reported / reconciled / failed` keeps the index
-- size bounded by the in-flight backlog (typically zero rows outside an
-- outage). The companion `metrc_transactions_failed_idx` exists for the
-- admin alert query (`SELECT … WHERE status = 'failed' ORDER BY
-- updated_at DESC`); it is tiny in steady state.
-- ============================================================================

ALTER TABLE "metrc_transactions"
  ADD COLUMN "next_retry_at" timestamptz NOT NULL DEFAULT NOW();
--> statement-breakpoint

DROP INDEX IF EXISTS "metrc_transactions_status_idx";
--> statement-breakpoint

CREATE INDEX "metrc_transactions_due_idx"
  ON "metrc_transactions" ("next_retry_at")
  WHERE "status" = 'pending';
--> statement-breakpoint

CREATE INDEX "metrc_transactions_failed_idx"
  ON "metrc_transactions" ("updated_at")
  WHERE "status" = 'failed';
