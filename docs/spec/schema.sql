-- ============================================================================
-- DankDash — Postgres Schema
-- Target: PostgreSQL 16
-- Extensions: uuid-ossp, postgis, pg_trgm, pgcrypto, citext
-- ============================================================================
--
-- Conventions:
--   - All PKs are uuid (v7 from app layer; gen_random_uuid() as fallback)
--   - Money in cents as integer; lab-precision values as numeric
--   - Soft delete via deleted_at on domain tables
--   - Audit columns: created_at, updated_at, created_by, updated_by
--   - History tables are append-only — no UPDATE/DELETE permitted to app role
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ----------------------------------------------------------------------------
-- Reusable trigger for updated_at
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- IDENTITY & AUTH
-- ============================================================================

CREATE TYPE user_role AS ENUM (
  'customer', 'budtender', 'manager', 'owner',
  'driver', 'admin', 'superadmin'
);

CREATE TYPE user_status AS ENUM (
  'pending_kyc', 'active', 'suspended', 'banned'
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE NOT NULL,
  phone           text UNIQUE,
  password_hash   text NOT NULL,
  role            user_role NOT NULL DEFAULT 'customer',
  status          user_status NOT NULL DEFAULT 'pending_kyc',
  first_name      text,
  last_name       text,
  date_of_birth   date,
  kyc_verified_at timestamptz,
  kyc_provider    text,
  kyc_provider_ref text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret_enc  bytea,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  deleted_at      timestamptz,
  CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+[1-9]\d{1,14}$'),
  CONSTRAINT users_dob_realistic CHECK (date_of_birth IS NULL OR date_of_birth > '1900-01-01')
);
CREATE INDEX users_role_status_idx ON users (role, status) WHERE deleted_at IS NULL;
CREATE INDEX users_phone_idx ON users (phone) WHERE phone IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  region       text NOT NULL,
  postal_code  text NOT NULL,
  country      text NOT NULL DEFAULT 'US',
  location     geography(POINT, 4326) NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  is_validated boolean NOT NULL DEFAULT false,
  validated_at timestamptz,
  delivery_instructions text,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  deleted_at   timestamptz
);
CREATE INDEX user_addresses_user_idx ON user_addresses (user_id) WHERE deleted_at IS NULL;
CREATE INDEX user_addresses_location_idx ON user_addresses USING GIST (location);
CREATE UNIQUE INDEX user_addresses_one_default ON user_addresses (user_id)
  WHERE is_default = true AND deleted_at IS NULL;
CREATE TRIGGER user_addresses_updated_at BEFORE UPDATE ON user_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE id_document_type AS ENUM (
  'drivers_license', 'passport', 'state_id', 'military_id', 'tribal_id'
);

CREATE TABLE user_id_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type                  id_document_type NOT NULL,
  issuing_region        text,
  document_number_hash  bytea NOT NULL,        -- sha256 hash for dedupe lookup
  scan_image_key        text,                  -- R2 object key (encrypted blob)
  selfie_image_key      text,
  verified              boolean NOT NULL DEFAULT false,
  verified_at           timestamptz,
  expires_at            date,
  verification_provider text,
  verification_ref      text,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX user_id_documents_user_idx ON user_id_documents (user_id);
CREATE TRIGGER user_id_documents_updated_at BEFORE UPDATE ON user_id_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  bytea NOT NULL UNIQUE,
  device_id           text,
  device_fingerprint  jsonb,
  ip_address          inet,
  user_agent          text,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  last_used_at        timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ============================================================================
-- DISPENSARIES & STAFF
-- ============================================================================

CREATE TYPE license_type AS ENUM (
  'retailer', 'microbusiness', 'mezzobusiness', 'medical_combo',
  'delivery_service', 'lphe_retailer'
);

CREATE TYPE dispensary_status AS ENUM (
  'onboarding', 'active', 'paused', 'terminated'
);

CREATE TYPE pos_provider AS ENUM (
  'dutchie', 'flowhub', 'treez', 'greenbits', 'cova', 'manual'
);

CREATE TABLE dispensaries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name               text NOT NULL,
  dba                      text,
  license_number           text NOT NULL UNIQUE,
  license_type             license_type NOT NULL,
  license_issued_at        date NOT NULL,
  license_expires_at       date NOT NULL,
  metrc_facility_id        text,
  metrc_api_key_enc        bytea,                 -- encrypted at rest
  pos_provider             pos_provider NOT NULL DEFAULT 'manual',
  pos_credentials_enc      bytea,
  pos_last_synced_at       timestamptz,
  address_line1            text NOT NULL,
  address_line2            text,
  city                     text NOT NULL,
  region                   text NOT NULL,
  postal_code              text NOT NULL,
  location                 geography(POINT, 4326) NOT NULL,
  delivery_polygon         geography(POLYGON, 4326) NOT NULL,
  hours_json               jsonb NOT NULL,        -- {mon:{open:"08:00",close:"22:00"}, ...}
  phone                    text,
  email                    citext,
  logo_image_key           text,
  hero_image_key           text,
  brand_color_hex          text,
  aeropay_account_ref      text,
  is_accepting_orders      boolean NOT NULL DEFAULT false,
  rating_avg               numeric(3,2),
  rating_count             integer NOT NULL DEFAULT 0,
  status                   dispensary_status NOT NULL DEFAULT 'onboarding',
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  updated_at               timestamptz NOT NULL DEFAULT NOW(),
  deleted_at               timestamptz
);
CREATE INDEX dispensaries_status_idx ON dispensaries (status) WHERE deleted_at IS NULL;
CREATE INDEX dispensaries_location_idx ON dispensaries USING GIST (location);
CREATE INDEX dispensaries_polygon_idx ON dispensaries USING GIST (delivery_polygon);
CREATE TRIGGER dispensaries_updated_at BEFORE UPDATE ON dispensaries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE staff_role AS ENUM ('budtender', 'manager', 'owner');

CREATE TABLE dispensary_staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispensary_id  uuid NOT NULL REFERENCES dispensaries(id) ON DELETE RESTRICT,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role           staff_role NOT NULL,
  permissions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  invited_at     timestamptz NOT NULL DEFAULT NOW(),
  invited_by     uuid REFERENCES users(id),
  accepted_at    timestamptz,
  removed_at     timestamptz,
  UNIQUE (dispensary_id, user_id)
);
CREATE INDEX dispensary_staff_user_idx ON dispensary_staff (user_id) WHERE removed_at IS NULL;
CREATE INDEX dispensary_staff_dispensary_idx ON dispensary_staff (dispensary_id) WHERE removed_at IS NULL;

-- ============================================================================
-- CATALOG
-- ============================================================================

CREATE TABLE product_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  display_name text NOT NULL,
  parent_id    uuid REFERENCES product_categories(id),
  display_order integer NOT NULL DEFAULT 0,
  icon_key     text
);

CREATE TYPE product_type AS ENUM (
  'flower', 'preroll', 'infused_preroll', 'vape', 'edible',
  'beverage', 'concentrate', 'tincture', 'topical', 'accessory', 'seed', 'clone'
);

CREATE TYPE strain_type AS ENUM ('indica', 'sativa', 'hybrid', 'cbd', 'balanced');

CREATE TABLE products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id            uuid NOT NULL REFERENCES product_categories(id),
  brand                  text NOT NULL,
  name                   text NOT NULL,
  description            text,
  product_type           product_type NOT NULL,
  strain_type            strain_type,
  thc_mg_per_unit        numeric(10,3) NOT NULL,
  cbd_mg_per_unit        numeric(10,3) NOT NULL DEFAULT 0,
  weight_grams_per_unit  numeric(10,3) NOT NULL DEFAULT 0,
  serving_count          integer,
  thc_mg_per_serving     numeric(10,3),
  image_keys             text[] NOT NULL DEFAULT ARRAY[]::text[],
  search_vector          tsvector,
  effects_tags           text[] NOT NULL DEFAULT ARRAY[]::text[],  -- "uplifting", "relaxing"
  flavor_tags            text[] NOT NULL DEFAULT ARRAY[]::text[],
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT NOW(),
  updated_at             timestamptz NOT NULL DEFAULT NOW(),
  deleted_at             timestamptz,
  CONSTRAINT products_thc_nonnegative CHECK (thc_mg_per_unit >= 0),
  CONSTRAINT products_cbd_nonnegative CHECK (cbd_mg_per_unit >= 0),
  CONSTRAINT products_weight_nonnegative CHECK (weight_grams_per_unit >= 0),
  -- MN beverages: ≤10 mg THC per serving, ≤2 servings per container
  CONSTRAINT products_beverage_potency_cap CHECK (
    product_type != 'beverage' OR thc_mg_per_serving <= 10
  ),
  CONSTRAINT products_beverage_serving_cap CHECK (
    product_type != 'beverage' OR serving_count <= 2
  )
);
CREATE INDEX products_search_idx ON products USING GIN (search_vector);
CREATE INDEX products_category_idx ON products (category_id) WHERE is_active = true;
CREATE INDEX products_type_idx ON products (product_type) WHERE is_active = true;
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION products_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.brand,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description,'')), 'C') ||
    setweight(to_tsvector('english', array_to_string(NEW.effects_tags, ' ')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER products_search_vector_trg BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();

CREATE TABLE dispensary_listings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispensary_id           uuid NOT NULL REFERENCES dispensaries(id) ON DELETE RESTRICT,
  product_id              uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku                     text NOT NULL,
  price_cents             integer NOT NULL,
  compare_at_price_cents  integer,
  quantity_available      integer NOT NULL DEFAULT 0,
  metrc_package_tag       text,
  last_synced_at          timestamptz,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (dispensary_id, sku),
  CONSTRAINT dispensary_listings_price_positive CHECK (price_cents > 0),
  CONSTRAINT dispensary_listings_qty_nonnegative CHECK (quantity_available >= 0)
);
CREATE INDEX dispensary_listings_dispensary_active_idx
  ON dispensary_listings (dispensary_id, is_active)
  WHERE quantity_available > 0;
CREATE INDEX dispensary_listings_product_idx ON dispensary_listings (product_id);
CREATE TRIGGER dispensary_listings_updated_at BEFORE UPDATE ON dispensary_listings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_lab_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id            text NOT NULL,
  lab_name            text NOT NULL,
  coa_document_key    text,
  potency_thc         numeric(6,3),
  potency_cbd         numeric(6,3),
  contaminants_passed boolean,
  tested_at           date NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, batch_id)
);

-- ============================================================================
-- CART & ORDERS
-- ============================================================================

CREATE TABLE carts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dispensary_id  uuid NOT NULL REFERENCES dispensaries(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL DEFAULT (NOW() + interval '4 hours'),
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dispensary_id)
);
CREATE INDEX carts_user_idx ON carts (user_id);
CREATE INDEX carts_expires_idx ON carts (expires_at);
CREATE TRIGGER carts_updated_at BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cart_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id         uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  listing_id      uuid NOT NULL REFERENCES dispensary_listings(id) ON DELETE RESTRICT,
  quantity        integer NOT NULL,
  unit_price_cents integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (cart_id, listing_id),
  CONSTRAINT cart_items_qty_positive CHECK (quantity > 0)
);
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);
CREATE TRIGGER cart_items_updated_at BEFORE UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE order_status AS ENUM (
  'placed', 'payment_failed', 'accepted', 'rejected',
  'prepping', 'ready_for_pickup', 'awaiting_driver',
  'driver_assigned', 'en_route_pickup', 'picked_up', 'en_route_dropoff',
  'arrived_at_dropoff', 'id_scan_pending', 'id_scan_passed', 'id_scan_failed',
  'delivered', 'returned_to_store', 'canceled', 'disputed'
);

CREATE TABLE orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code                  text NOT NULL UNIQUE,
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dispensary_id               uuid NOT NULL REFERENCES dispensaries(id) ON DELETE RESTRICT,
  driver_id                   uuid REFERENCES users(id) ON DELETE RESTRICT,
  delivery_address_id         uuid NOT NULL REFERENCES user_addresses(id) ON DELETE RESTRICT,

  status                      order_status NOT NULL DEFAULT 'placed',
  status_changed_at           timestamptz NOT NULL DEFAULT NOW(),

  -- pricing snapshot (immutable after placement)
  subtotal_cents              integer NOT NULL,
  cannabis_tax_cents          integer NOT NULL,
  sales_tax_cents             integer NOT NULL,
  delivery_fee_cents          integer NOT NULL,
  driver_tip_cents            integer NOT NULL DEFAULT 0,
  discount_cents              integer NOT NULL DEFAULT 0,
  total_cents                 integer NOT NULL,

  -- compliance snapshot (immutable)
  compliance_check_payload    jsonb NOT NULL,

  -- delivery address snapshot
  delivery_address_snapshot   jsonb NOT NULL,

  -- timestamps
  placed_at                   timestamptz NOT NULL DEFAULT NOW(),
  accepted_at                 timestamptz,
  prepared_at                 timestamptz,
  picked_up_at                timestamptz,
  delivered_at                timestamptz,
  canceled_at                 timestamptz,
  canceled_by                 uuid REFERENCES users(id),
  cancel_reason               text,

  -- delivery verification
  delivery_id_scan_ref        text,
  delivery_id_scan_passed     boolean,
  delivery_id_scan_at         timestamptz,

  -- post delivery
  customer_rating             smallint,
  customer_review             text,
  dispensary_rating           smallint,
  driver_rating               smallint,

  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT orders_total_matches CHECK (
    total_cents = subtotal_cents + cannabis_tax_cents + sales_tax_cents
                  + delivery_fee_cents + driver_tip_cents - discount_cents
  ),
  CONSTRAINT orders_rating_range CHECK (
    (customer_rating IS NULL OR customer_rating BETWEEN 1 AND 5) AND
    (dispensary_rating IS NULL OR dispensary_rating BETWEEN 1 AND 5) AND
    (driver_rating IS NULL OR driver_rating BETWEEN 1 AND 5)
  )
);
CREATE INDEX orders_user_placed_idx ON orders (user_id, placed_at DESC);
CREATE INDEX orders_dispensary_status_idx ON orders (dispensary_id, status, placed_at DESC);
CREATE INDEX orders_driver_idx ON orders (driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX orders_status_idx ON orders (status, placed_at);
CREATE INDEX orders_active_idx ON orders (placed_at) WHERE status NOT IN ('delivered','canceled','rejected');
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  listing_id          uuid NOT NULL REFERENCES dispensary_listings(id) ON DELETE RESTRICT,
  product_snapshot    jsonb NOT NULL,    -- full product details at order time
  metrc_package_tag   text,
  quantity            integer NOT NULL,
  unit_price_cents    integer NOT NULL,
  line_subtotal_cents integer NOT NULL,
  thc_mg_total        numeric(12,3) NOT NULL,
  cbd_mg_total        numeric(12,3) NOT NULL DEFAULT 0,
  weight_grams_total  numeric(12,3) NOT NULL DEFAULT 0,
  cannabis_tax_cents  integer NOT NULL,
  sales_tax_cents     integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT order_items_qty_positive CHECK (quantity > 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_listing_idx ON order_items (listing_id);

-- Append-only event log
CREATE TABLE order_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  event_type    text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_role    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (occurred_at);
CREATE INDEX order_events_order_idx ON order_events (order_id, occurred_at);

-- Example partition (CI/migration script generates these monthly)
CREATE TABLE order_events_2026_05 PARTITION OF order_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- ============================================================================
-- PAYMENTS & LEDGER
-- ============================================================================

CREATE TYPE payment_method_type AS ENUM ('aeropay_ach', 'cash');

CREATE TYPE payment_method_status AS ENUM ('pending', 'active', 'failed', 'revoked');

CREATE TABLE payment_methods (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                        payment_method_type NOT NULL,
  aeropay_payment_method_ref  text,
  bank_name                   text,
  last4                       text,
  is_default                  boolean NOT NULL DEFAULT false,
  status                      payment_method_status NOT NULL DEFAULT 'pending',
  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW(),
  deleted_at                  timestamptz
);
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX payment_methods_one_default ON payment_methods (user_id)
  WHERE is_default = true AND deleted_at IS NULL;
CREATE TRIGGER payment_methods_updated_at BEFORE UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE payment_status AS ENUM (
  'initiated', 'authorized', 'settled', 'failed', 'refunded', 'partially_refunded'
);

CREATE TABLE payment_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_method_id     uuid REFERENCES payment_methods(id),
  provider              text NOT NULL,         -- 'aeropay'
  provider_ref          text NOT NULL,
  amount_cents          integer NOT NULL,
  status                payment_status NOT NULL,
  failure_code          text,
  failure_reason        text,
  initiated_at          timestamptz NOT NULL DEFAULT NOW(),
  authorized_at         timestamptz,
  settled_at            timestamptz,
  failed_at             timestamptz,
  raw_response          jsonb,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payment_transactions_order_idx ON payment_transactions (order_id);
CREATE TRIGGER payment_transactions_updated_at BEFORE UPDATE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE ledger_account_type AS ENUM (
  'customer', 'dispensary', 'driver', 'platform_revenue',
  'cannabis_tax', 'sales_tax', 'aeropay_clearing', 'refund_reserve'
);

-- Double-entry ledger. Append-only.
CREATE TABLE ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid REFERENCES orders(id),
  payout_id     uuid,                          -- FK to payouts after that table is created
  refund_id     uuid,                          -- FK to refunds
  account_type  ledger_account_type NOT NULL,
  account_ref   uuid,                          -- user_id / dispensary_id / etc.
  debit_cents   integer NOT NULL DEFAULT 0,
  credit_cents  integer NOT NULL DEFAULT 0,
  description   text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT NOW(),
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT ledger_one_side_only CHECK (
    (debit_cents > 0 AND credit_cents = 0) OR
    (credit_cents > 0 AND debit_cents = 0)
  ),
  CONSTRAINT ledger_nonneg CHECK (debit_cents >= 0 AND credit_cents >= 0)
);
CREATE INDEX ledger_order_idx ON ledger_entries (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX ledger_account_idx ON ledger_entries (account_type, account_ref, occurred_at);

CREATE TYPE payout_recipient AS ENUM ('dispensary', 'driver');
CREATE TYPE payout_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'canceled');

CREATE TABLE payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type      payout_recipient NOT NULL,
  recipient_id        uuid NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  gross_cents         integer NOT NULL,
  fees_cents          integer NOT NULL DEFAULT 0,
  net_cents           integer NOT NULL,
  aeropay_payout_ref  text,
  status              payout_status NOT NULL DEFAULT 'pending',
  scheduled_for       date NOT NULL,
  initiated_at        timestamptz,
  completed_at        timestamptz,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX payouts_recipient_idx ON payouts (recipient_type, recipient_id, period_end DESC);
CREATE INDEX payouts_status_idx ON payouts (status, scheduled_for);
CREATE TRIGGER payouts_updated_at BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE refund_status AS ENUM ('pending', 'completed', 'failed', 'canceled');

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents    integer NOT NULL,
  reason_code     text NOT NULL,
  reason_notes    text,
  initiated_by    uuid NOT NULL REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  provider_ref    text,
  status          refund_status NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  completed_at    timestamptz,
  CONSTRAINT refunds_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT refunds_separation_of_duties CHECK (initiated_by != approved_by OR approved_by IS NULL)
);
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- ============================================================================
-- DISPATCH & TRACKING
-- ============================================================================

CREATE TYPE driver_status AS ENUM (
  'offline', 'online', 'en_route_pickup', 'en_route_dropoff', 'on_break', 'unavailable'
);

CREATE TABLE drivers (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  license_number_hash             bytea NOT NULL,
  vehicle_make                    text,
  vehicle_model                   text,
  vehicle_year                    integer,
  vehicle_plate                   text,
  vehicle_color                   text,
  insurance_doc_key               text,
  insurance_expires_at            date,
  background_check_passed_at      date,
  background_check_provider_ref   text,
  current_status                  driver_status NOT NULL DEFAULT 'offline',
  last_status_change_at           timestamptz NOT NULL DEFAULT NOW(),
  current_location                geography(POINT, 4326),
  current_location_updated_at     timestamptz,
  current_order_id                uuid REFERENCES orders(id),
  rating_avg                      numeric(3,2),
  rating_count                    integer NOT NULL DEFAULT 0,
  total_deliveries                integer NOT NULL DEFAULT 0,
  created_at                      timestamptz NOT NULL DEFAULT NOW(),
  updated_at                      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX drivers_status_location_idx ON drivers USING GIST (current_location)
  WHERE current_status = 'online';
CREATE INDEX drivers_current_order_idx ON drivers (current_order_id) WHERE current_order_id IS NOT NULL;
CREATE TRIGGER drivers_updated_at BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE driver_shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  started_at            timestamptz NOT NULL DEFAULT NOW(),
  ended_at              timestamptz,
  starting_location     geography(POINT, 4326),
  ending_location       geography(POINT, 4326),
  total_miles           numeric(8,2),
  total_deliveries      integer NOT NULL DEFAULT 0,
  total_earnings_cents  integer NOT NULL DEFAULT 0
);
CREATE INDEX driver_shifts_driver_idx ON driver_shifts (driver_id, started_at DESC);
CREATE INDEX driver_shifts_active_idx ON driver_shifts (driver_id) WHERE ended_at IS NULL;

-- Hot, high-volume table — declarative range partition by week
CREATE TABLE driver_location_history (
  id              bigserial,
  driver_id       uuid NOT NULL,
  order_id        uuid,
  location        geography(POINT, 4326) NOT NULL,
  accuracy_meters numeric(8,2),
  speed_mps       numeric(6,2),
  heading_deg     numeric(5,2),
  battery_pct     smallint,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE INDEX dlh_driver_recorded_idx ON driver_location_history (driver_id, recorded_at DESC);
CREATE INDEX dlh_order_idx ON driver_location_history (order_id) WHERE order_id IS NOT NULL;
-- Example partition
CREATE TABLE driver_location_history_2026_w20 PARTITION OF driver_location_history
  FOR VALUES FROM ('2026-05-11') TO ('2026-05-18');

CREATE TYPE offer_status AS ENUM ('offered', 'accepted', 'declined', 'expired');

CREATE TABLE dispatch_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  driver_id             uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  offered_at            timestamptz NOT NULL DEFAULT NOW(),
  expires_at            timestamptz NOT NULL,
  payout_estimate_cents integer NOT NULL,
  distance_miles        numeric(6,2) NOT NULL,
  status                offer_status NOT NULL DEFAULT 'offered',
  responded_at          timestamptz,
  decline_reason        text
);
CREATE INDEX dispatch_offers_order_idx ON dispatch_offers (order_id);
CREATE INDEX dispatch_offers_driver_idx ON dispatch_offers (driver_id, offered_at DESC);
CREATE INDEX dispatch_offers_active_idx ON dispatch_offers (expires_at) WHERE status = 'offered';

-- ============================================================================
-- COMPLIANCE & TRACEABILITY
-- ============================================================================

CREATE TYPE compliance_check_type AS ENUM (
  'age', 'hours', 'per_transaction_limit', 'delivery_geofence',
  'id_scan', 'license_validity', 'product_provenance'
);

CREATE TABLE compliance_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type      compliance_check_type NOT NULL,
  subject_type    text NOT NULL,   -- 'order' | 'cart' | 'user' | 'dispensary'
  subject_id      uuid NOT NULL,
  passed          boolean NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_at    timestamptz NOT NULL DEFAULT NOW(),
  performed_by    uuid REFERENCES users(id)
);
CREATE INDEX compliance_checks_subject_idx ON compliance_checks (subject_type, subject_id, performed_at DESC);
CREATE INDEX compliance_checks_failures_idx ON compliance_checks (performed_at) WHERE passed = false;

CREATE TYPE metrc_status AS ENUM ('pending', 'reported', 'failed', 'reconciled');

CREATE TABLE metrc_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  metrc_receipt_id   text,
  package_tags       text[] NOT NULL,
  reported_at        timestamptz,
  status             metrc_status NOT NULL DEFAULT 'pending',
  retry_count        integer NOT NULL DEFAULT 0,
  response_payload   jsonb,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX metrc_transactions_status_idx ON metrc_transactions (status) WHERE status != 'reconciled';
CREATE TRIGGER metrc_transactions_updated_at BEFORE UPDATE ON metrc_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE verification_context AS ENUM ('signup', 'delivery_handoff', 'periodic_recheck');

CREATE TABLE age_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  context             verification_context NOT NULL,
  order_id            uuid REFERENCES orders(id),
  provider            text NOT NULL,
  provider_session_id text NOT NULL,
  passed              boolean NOT NULL,
  passed_at           timestamptz,
  failure_reason      text,
  scan_image_key      text,
  selfie_image_key    text,
  document_dob_value  date,
  created_at          timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX age_verifications_user_idx ON age_verifications (user_id, created_at DESC);
CREATE INDEX age_verifications_order_idx ON age_verifications (order_id) WHERE order_id IS NOT NULL;

-- ============================================================================
-- NOTIFICATIONS & AUDIT
-- ============================================================================

CREATE TYPE notification_channel AS ENUM ('push', 'sms', 'email', 'in_app');

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel       notification_channel NOT NULL,
  template_key  text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  provider_ref  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE TABLE notifications_2026_05 PARTITION OF notifications
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    text NOT NULL,
  apns_token   text NOT NULL,
  platform     text NOT NULL,        -- 'ios' for now
  app_variant  text NOT NULL,        -- 'consumer' | 'driver'
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id, app_variant)
);
CREATE INDEX push_tokens_active_idx ON push_tokens (user_id) WHERE is_active = true;
CREATE TRIGGER push_tokens_updated_at BEFORE UPDATE ON push_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_log (
  id              uuid DEFAULT gen_random_uuid(),
  actor_user_id   uuid REFERENCES users(id),
  actor_role      text,
  action          text NOT NULL,        -- 'user.suspend', 'order.refund', ...
  resource_type   text NOT NULL,
  resource_id     text NOT NULL,
  changes         jsonb,                -- before/after
  ip_address      inet,
  user_agent      text,
  occurred_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_resource_idx ON audit_log (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC);
CREATE TABLE audit_log_2026_05 PARTITION OF audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- ============================================================================
-- ROW-LEVEL SECURITY for vendor isolation
-- ============================================================================
-- Set app.current_dispensary_id per request from the API layer.

CREATE ROLE app_vendor NOLOGIN;
GRANT USAGE ON SCHEMA public TO app_vendor;
GRANT SELECT, INSERT, UPDATE ON
  orders, order_items, dispensary_listings, dispensary_staff, payouts, payment_transactions
TO app_vendor;

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_vendor_isolation ON orders FOR ALL TO app_vendor
  USING (dispensary_id = current_setting('app.current_dispensary_id', true)::uuid);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_items_vendor_isolation ON order_items FOR ALL TO app_vendor
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id
      AND o.dispensary_id = current_setting('app.current_dispensary_id', true)::uuid
  ));

ALTER TABLE dispensary_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY listings_vendor_isolation ON dispensary_listings FOR ALL TO app_vendor
  USING (dispensary_id = current_setting('app.current_dispensary_id', true)::uuid);

ALTER TABLE dispensary_staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_vendor_isolation ON dispensary_staff FOR ALL TO app_vendor
  USING (dispensary_id = current_setting('app.current_dispensary_id', true)::uuid);

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY payouts_vendor_isolation ON payouts FOR ALL TO app_vendor
  USING (recipient_type = 'dispensary'
         AND recipient_id = current_setting('app.current_dispensary_id', true)::uuid);

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ptx_vendor_isolation ON payment_transactions FOR ALL TO app_vendor
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = payment_transactions.order_id
      AND o.dispensary_id = current_setting('app.current_dispensary_id', true)::uuid
  ));

-- ============================================================================
-- END
-- ============================================================================
