-- ============================================================================
-- DankDash — 0012_password_reset_tokens
--
-- Adds the email-delivered password-reset token store. A reset request mints
-- a high-entropy code, emails it to the user, and persists only its SHA-256
-- (`code_hash`) — the plaintext code never touches the database, mirroring
-- the `sessions.refresh_token_hash` design.
--
-- Defence in depth against a stolen or guessed code:
--   • code entropy   — the code is 60 bits of CSPRNG output (Crockford base32),
--                      so an online guess effectively never finds a row and an
--                      offline grind of the hash can't finish inside the TTL
--   • expires_at     — short TTL (the service enforces 15 minutes)
--   • used_at        — single-use; also stamped on a user's still-active
--                      tokens when they request a new one, so a superseded
--                      code can never be redeemed
--
-- The UNIQUE on code_hash both prevents (astronomically unlikely) collisions
-- and lets the lookup-by-hash return at most one row. Two partial indexes
-- keep the hot paths — "active tokens for this user" (invalidation on a fresh
-- request) and "active tokens past expiry" (the cleanup sweep) — O(active)
-- rather than O(history).
--
-- Additive only: one new table, no changes to existing objects. Cutover risk = 0.
-- ============================================================================

CREATE TABLE "password_reset_tokens" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash"     bytea NOT NULL UNIQUE,
  "expires_at"    timestamptz NOT NULL,
  "used_at"       timestamptz,
  "requested_ip"  inet,
  "created_at"    timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX "password_reset_tokens_user_active_idx"
  ON "password_reset_tokens" ("user_id")
  WHERE used_at IS NULL;
--> statement-breakpoint

CREATE INDEX "password_reset_tokens_expires_idx"
  ON "password_reset_tokens" ("expires_at")
  WHERE used_at IS NULL;
