-- ============================================================================
-- DankDash — 0013_listing_image_keys
--
-- Adds a per-listing image override to `dispensary_listings`. Product photos
-- have historically lived only on `products.image_keys` — a single shared
-- catalog row that every dispensary carrying that product reads. That is the
-- right home for canonical, admin-curated product imagery, but it gives a
-- vendor no way to surface its own shots of the unit it actually stocks
-- without mutating data shared across tenants.
--
-- `image_keys` here is that per-vendor override:
--   • non-empty  — the public menu (`GET /v1/dispensaries/:id/menu`) renders
--                  these keys for this dispensary's listing
--   • empty      — falls back to `products.image_keys` (the default), so
--                  existing rows keep rendering the canonical photo with no
--                  backfill required
--
-- Keys are Cloudflare R2 object keys minted by the vendor presign endpoint
-- under the dispensary's own prefix (`dispensaries/<id>/listings/...`); the
-- write path rejects any key outside that prefix so one vendor cannot point
-- its listing at another tenant's (or the admin catalog's) objects.
--
-- Additive only: one new column with a safe default. No existing object
-- changes, no backfill, no RLS change (the column inherits the table's
-- existing per-dispensary policy). Cutover risk = 0.
-- ============================================================================

ALTER TABLE "dispensary_listings"
  ADD COLUMN "image_keys" text[] NOT NULL DEFAULT ARRAY[]::text[];
