-- ============================================================================
-- DankDash — 0014_notification_preferences
--
-- Per-user notification delivery preferences — exactly one row per user. The
-- consumer Account tab's "Notifications" screen reads and writes this table;
-- the NotificationDispatcher consults it on every fan-out to decide whether a
-- given (category, channel) pair should be delivered.
--
-- Two axes, both opt-OUT (everything defaults on):
--   • category — `order_updates_enabled`, `promotions_enabled`. These are the
--     only user-suppressible categories. Transactional + operational
--     notifications (payment, refund, auth, driver dispatch, vendor ops) are
--     never gated by this table — see SUPPRESSIBLE_CATEGORIES in
--     @dankdash/notifications, which is the single source of truth for which
--     template keys this table can suppress.
--   • channel — `push_enabled`, `sms_enabled`, `email_enabled`. The `in_app`
--     channel has no column: the in-app inbox row is always written, so it is
--     never suppressible.
--
-- The UNIQUE on `user_id` makes the row a true singleton and is the conflict
-- target the repository upserts against (insert-or-patch). A missing row means
-- "all defaults" — the dispatcher's deliver-everything fallback handles users
-- who never opened the screen, so no backfill is required.
--
-- Additive only: one new table, no changes to existing objects. Cutover risk = 0.
-- ============================================================================

CREATE TABLE "notification_preferences" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"               uuid NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "order_updates_enabled" boolean NOT NULL DEFAULT true,
  "promotions_enabled"    boolean NOT NULL DEFAULT true,
  "push_enabled"          boolean NOT NULL DEFAULT true,
  "sms_enabled"           boolean NOT NULL DEFAULT true,
  "email_enabled"         boolean NOT NULL DEFAULT true,
  "created_at"            timestamptz NOT NULL DEFAULT NOW(),
  "updated_at"            timestamptz NOT NULL DEFAULT NOW()
);
