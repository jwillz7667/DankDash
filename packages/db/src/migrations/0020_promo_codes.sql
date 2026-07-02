-- ============================================================================
-- DankDash — 0020_promo_codes
--
-- DoorDash-style promo / discount codes, platform-funded or dispensary-funded.
--
-- Two tables:
--   • promo_codes       — the coupon definitions. `code` is citext so lookups
--                         are case-insensitive and the unique index treats
--                         SAVE10 == save10. `scope` is the funding source: a
--                         'platform' code (dispensary_id NULL) reduces the
--                         platform's revenue leg at settlement; a 'dispensary'
--                         code (dispensary_id set) reduces that store's payout
--                         leg. CHECK constraints pin the value semantics per
--                         type (percent 1..100, fixed_amount cents > 0,
--                         free_delivery = 0) and the scope↔dispensary_id
--                         coupling so a malformed coupon can never be stored.
--   • promo_redemptions — one row per successful redemption, written inside
--                         the checkout transaction. order_id is UNIQUE (a promo
--                         applies at most once per order); global + per-user
--                         caps are aggregated off this table under the promo
--                         row lock at checkout, making them race-free.
--
-- Column additions:
--   • carts.promo_code_id           — the promo applied to a live cart (preview
--                                     only; ON DELETE SET NULL so deactivating a
--                                     promo never blocks on carts).
--   • orders.promo_code_id          — snapshot of the redeemed promo.
--   • orders.discount_funded_by     — who absorbs the discount, snapshotted so
--                                     the settlement path routes the cost
--                                     without joining back to the promo. Paired
--                                     with promo_code_id via CHECK: both set or
--                                     both null. The discount AMOUNT stays in
--                                     the existing orders.discount_cents column
--                                     and the orders_total_matches CHECK is
--                                     unchanged — a promo just makes it non-zero.
--
-- RLS mirrors dispensary_listings: the app_vendor role sees/writes only its own
-- dispensary's coupons and their redemptions. Platform coupons (dispensary_id
-- NULL) are invisible to vendor sessions and managed by admins on the primary
-- role. Additive only — no existing row changes, no backfill.
-- ============================================================================

CREATE TYPE "promo_code_type" AS ENUM ('percent', 'fixed_amount', 'free_delivery');
--> statement-breakpoint
CREATE TYPE "promo_code_scope" AS ENUM ('platform', 'dispensary');
--> statement-breakpoint
CREATE TYPE "discount_funded_by" AS ENUM ('platform', 'dispensary');
--> statement-breakpoint
CREATE TABLE "promo_codes" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code"                      citext NOT NULL,
  "type"                      "promo_code_type" NOT NULL,
  "value"                     integer NOT NULL,
  "scope"                     "promo_code_scope" NOT NULL,
  "dispensary_id"             uuid REFERENCES "dispensaries"("id") ON DELETE CASCADE,
  "min_subtotal_cents"        integer NOT NULL DEFAULT 0,
  "max_discount_cents"        integer,
  "starts_at"                 timestamptz NOT NULL,
  "ends_at"                   timestamptz,
  "max_redemptions"           integer,
  "max_redemptions_per_user"  integer NOT NULL DEFAULT 1,
  "active"                    boolean NOT NULL DEFAULT true,
  "created_by"                uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "promo_codes_code_uq" UNIQUE ("code"),
  CONSTRAINT "promo_codes_scope_dispensary"
    CHECK (("scope" = 'dispensary') = ("dispensary_id" IS NOT NULL)),
  CONSTRAINT "promo_codes_value_by_type"
    CHECK (("type" = 'percent' AND "value" BETWEEN 1 AND 100)
        OR ("type" = 'fixed_amount' AND "value" > 0)
        OR ("type" = 'free_delivery' AND "value" = 0)),
  CONSTRAINT "promo_codes_min_subtotal_nonneg" CHECK ("min_subtotal_cents" >= 0),
  CONSTRAINT "promo_codes_max_discount_positive"
    CHECK ("max_discount_cents" IS NULL OR "max_discount_cents" > 0),
  CONSTRAINT "promo_codes_max_redemptions_positive"
    CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0),
  CONSTRAINT "promo_codes_max_per_user_positive" CHECK ("max_redemptions_per_user" > 0),
  CONSTRAINT "promo_codes_window" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);
--> statement-breakpoint
CREATE INDEX "promo_codes_dispensary_idx"
  ON "promo_codes" ("dispensary_id")
  WHERE "dispensary_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promo_id"              uuid NOT NULL REFERENCES "promo_codes"("id") ON DELETE RESTRICT,
  "user_id"               uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "order_id"              uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "amount_applied_cents"  integer NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "promo_redemptions_order_uq" UNIQUE ("order_id"),
  CONSTRAINT "promo_redemptions_amount_nonneg" CHECK ("amount_applied_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX "promo_redemptions_promo_user_idx"
  ON "promo_redemptions" ("promo_id", "user_id");
--> statement-breakpoint
CREATE INDEX "promo_redemptions_promo_idx" ON "promo_redemptions" ("promo_id");
--> statement-breakpoint
ALTER TABLE "carts"
  ADD COLUMN "promo_code_id" uuid REFERENCES "promo_codes"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "orders"
  ADD COLUMN "promo_code_id" uuid REFERENCES "promo_codes"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_funded_by" "discount_funded_by";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promo_funding_consistency"
  CHECK (("promo_code_id" IS NULL) = ("discount_funded_by" IS NULL));
--> statement-breakpoint
-- Vendor isolation. app_vendor manages only its own dispensary's coupons and
-- sees only their redemptions; platform coupons (dispensary_id NULL) are out
-- of a vendor session's reach and belong to the admin surface.
GRANT SELECT, INSERT, UPDATE ON "promo_codes", "promo_redemptions" TO app_vendor;
--> statement-breakpoint
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY promo_codes_vendor_isolation ON "promo_codes" FOR ALL TO app_vendor
  USING ("dispensary_id" = current_setting('app.current_dispensary_id', true)::uuid)
  WITH CHECK ("dispensary_id" = current_setting('app.current_dispensary_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "promo_redemptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY promo_redemptions_vendor_isolation ON "promo_redemptions" FOR ALL TO app_vendor
  USING (EXISTS (
    SELECT 1 FROM "promo_codes" p
    WHERE p.id = "promo_redemptions".promo_id
      AND p.dispensary_id = current_setting('app.current_dispensary_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "promo_codes" p
    WHERE p.id = "promo_redemptions".promo_id
      AND p.dispensary_id = current_setting('app.current_dispensary_id', true)::uuid
  ));
