-- ============================================================================
-- DankDash — 0026_user_favorites
--
-- Consumer "saved dispensaries / products" (DoorDash-style favorites), behind
-- `/v1/me/favorites`. One polymorphic table instead of two junction tables so
-- the Favorites feed reads from a single reverse-chronological source without a
-- UNION, while an exclusive-arc CHECK keeps a real FK on both target types.
--
--   • `favoritable_type` is the discriminator.
--   • `dispensary_id` / `product_id` are the two arms; the CHECK forces exactly
--     one arm populated AND matching the discriminator — never both, never
--     neither, never mismatched.
--   • Both arms FK their target ON DELETE CASCADE. Favorites are disposable
--     derived data: a hard-deleted target drops its saves. Soft-deleted /
--     inactive targets survive the FK and are filtered out at read time (same
--     404 semantics the catalog + dispensary read paths already apply).
--   • `user_id` cascades with the account.
--
-- The two partial unique indexes make a save idempotent per (user, target) —
-- the API PUT relies on ON CONFLICT DO NOTHING against them. The feed index
-- serves the only list query: newest-saved first, scoped to the owner. It
-- includes `id DESC` as a stable tiebreaker so offset pagination is
-- deterministic under equal `created_at`.
--
-- No RLS: rows are user-scoped (not dispensary-tenant), guarded at the app
-- layer by JWT identity + `WHERE user_id = ?`. Additive only; cutover risk = 0.
-- ============================================================================

CREATE TYPE "favoritable_type" AS ENUM ('dispensary', 'product');
--> statement-breakpoint
CREATE TABLE "user_favorites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "favoritable_type" "favoritable_type" NOT NULL,
  "dispensary_id" uuid REFERENCES "dispensaries" ("id") ON DELETE CASCADE,
  "product_id" uuid REFERENCES "products" ("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_favorites_exclusive_arc" CHECK (
    ("favoritable_type" = 'dispensary' AND "dispensary_id" IS NOT NULL AND "product_id" IS NULL)
    OR ("favoritable_type" = 'product' AND "product_id" IS NOT NULL AND "dispensary_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_favorites_user_dispensary_uniq"
  ON "user_favorites" ("user_id", "dispensary_id")
  WHERE "dispensary_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_favorites_user_product_uniq"
  ON "user_favorites" ("user_id", "product_id")
  WHERE "product_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "user_favorites_user_feed_idx"
  ON "user_favorites" ("user_id", "created_at" DESC, "id" DESC);
