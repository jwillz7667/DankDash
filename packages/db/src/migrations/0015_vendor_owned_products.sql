-- ============================================================================
-- DankDash — 0015_vendor_owned_products
--
-- Adds vendor ownership to the product catalog. Historically `products` has
-- been a single global, admin-curated catalog: every row is shared, mutated
-- only through `/v1/admin/products`, and a dispensary attaches to it via
-- `dispensary_listings`. That is the right home for canonical, admin-owned
-- SKUs — but it gives an operator no way to author its OWN product (name,
-- potency, photos, the lot) and stock it.
--
-- `created_by_dispensary_id` is that ownership marker:
--   • NULL      — the existing global admin catalog. Every current row stays
--                 NULL, every existing query ignores the column, and the
--                 public menu (keyed on `dispensary_listings.dispensary_id`,
--                 not product ownership) renders these exactly as before.
--   • non-NULL  — a vendor-owned product. Only the owning dispensary may read
--                 or mutate it through the vendor surface (app-layer
--                 `WHERE created_by_dispensary_id = ?`, mirroring the
--                 `dispensary_listings` tenant guard), and the public catalog
--                 browse filters it OUT (`created_by_dispensary_id IS NULL`)
--                 so one tenant's private SKU never pollutes the global
--                 search. It still reaches shoppers the moment the owning
--                 dispensary lists it, via the dispensary menu.
--
-- ON DELETE RESTRICT: a dispensary with authored products cannot be hard
-- deleted out from under them (dispensaries are tombstoned, never dropped, so
-- this is belt-and-suspenders integrity).
--
-- The partial index serves the vendor "my products" list, which always scopes
-- by owner and excludes tombstones.
--
-- Additive only: one nullable column with no default. No existing object
-- changes, no backfill, no RLS change. Cutover risk = 0.
-- ============================================================================

ALTER TABLE "products"
  ADD COLUMN "created_by_dispensary_id" uuid REFERENCES "dispensaries" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "products_owner_idx"
  ON "products" ("created_by_dispensary_id")
  WHERE "created_by_dispensary_id" IS NOT NULL AND "deleted_at" IS NULL;
