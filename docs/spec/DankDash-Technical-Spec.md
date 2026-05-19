# DankDash Platform — Technical Specification

**Version:** 1.0
**Date:** May 2026
**Author:** Engineering
**Scope:** Three-sided cannabis delivery marketplace for the Minnesota adult-use market

---

## 0. Executive Summary

DankDash is a three-sided marketplace operating in Minnesota's adult-use cannabis market under HF 100 / Minn. Stat. ch. 342. The platform consists of:

1. **DankDash** — Consumer iOS app (SwiftUI, iOS 17+)
2. **DankDash for Business** — Vendor web portal (Next.js 15, deployed on Vercel)
3. **DankDasher** — Driver iOS app (SwiftUI, iOS 17+)

A unified backend (NestJS on Railway), Postgres database (Railway-managed), Redis (caching + queues), and a dedicated Socket.io realtime service power all three clients. Payments flow through Aeropay (ACH). State traceability is maintained via Metrc integration. Identity verification is handled via Persona (KYC) and Veriff (delivery-time ID scan).

The platform is regulated. Every architectural decision below assumes that an OCM auditor, a tax auditor, and Metrc reconciliation jobs will all be reading our data within a year of launch. Build accordingly.

---

## 1. Regulatory Framework — Non-Negotiables

These constraints are baked into the code, not the policy doc:

| Constraint | Source | Implementation |
|---|---|---|
| Buyer must be 21+ | Minn. Stat. § 342.09 | Persona KYC at signup + Veriff scan at delivery |
| Per-transaction limit: 2 oz flower, 8 g concentrate, 800 mg edibles THC | Minn. Stat. § 342.27(c) | Server-side cart validator (`ComplianceService.validateCart`) |
| Sale hours: 8:00 AM – 2:00 AM local | Minn. Stat. § 342.27 | Order-creation guard; dispensary-level override down (not up) |
| Beverages ≤10 mg THC/serving, ≤2 servings/container | Minn. Stat. § 342.27(e) | Product schema constraint + admission validator |
| Seed-to-sale traceability | OCM rule | Metrc API integration on every order line |
| Driver ID scan at handoff | OCM delivery rule | Veriff SDK in DankDasher app, non-bypassable |
| No interstate transport | Federal | Geofence — delivery addresses validated against MN polygon |
| No sales in school zones, federal property, etc. | Local zoning | Dispensary delivery polygons set per-store, validated server-side |
| Tax: 10% cannabis tax + state/local sales tax | Minn. Stat. § 295.81 | Calculated server-side, persisted per line item |

A failure on any of these is an existential threat to the business. They are tested as contract tests, not unit tests, and live in `packages/compliance/`.

---

## 2. System Architecture

### 2.1 Component Diagram

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   DankDash iOS  │    │  Vendor Portal  │    │  DankDasher iOS │
│   (SwiftUI)     │    │  (Next.js 15)   │    │   (SwiftUI)     │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         │  HTTPS (REST/GraphQL)│  + WSS (Socket.io)   │
         │                      │                      │
         └──────────┬───────────┴──────────┬───────────┘
                    │                      │
         ┌──────────▼──────────┐  ┌────────▼─────────┐
         │   API Gateway       │  │  Realtime Svc    │
         │   (NestJS)          │  │  (Socket.io)     │
         │   Railway           │  │  Railway         │
         └──────────┬──────────┘  └────────┬─────────┘
                    │                      │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐
        │ Postgres  │   │   Redis     │  │  S3 / R2   │
        │ (Railway) │   │  (Railway)  │  │  (Images)  │
        └───────────┘   └─────────────┘  └────────────┘

External: Metrc API • Aeropay • Persona • Veriff • Mapbox • Twilio • Resend • Sentry
```

### 2.2 Service Boundaries

The backend is a modular monolith, not microservices. Cannabis delivery has tight coupling between domains (an order touches inventory, compliance, payments, dispatch, traceability, and notifications in one transaction) — microservices would mean distributed transactions for every order, which is over-engineering for the scale we'll see in years 1–2.

Modules (NestJS):

- `auth` — JWT issuance, refresh tokens, MFA, Persona webhook
- `identity` — User accounts, KYC state, ID document storage refs
- `catalog` — Dispensaries, products, categories, pricing, inventory snapshots
- `inventory` — POS sync (Dutchie/Flowhub/Treez), reservations
- `cart` — Cart state, compliance validation
- `orders` — Order lifecycle, state machine, audit log
- `payments` — Aeropay integration, refunds, payouts, ledger
- `dispatch` — Driver assignment, route optimization, ETAs
- `tracking` — Live location ingestion, geofencing, replay
- `compliance` — Limits, hours, geofence, age verification orchestration
- `traceability` — Metrc sync, tag association, sale reporting
- `notifications` — Push (APNs), SMS (Twilio), email (Resend)
- `admin` — Internal operations console
- `reporting` — Vendor analytics, tax reports, OCM exports

Each module owns its tables. Cross-module reads go through repository interfaces — never raw cross-domain SQL joins. This gives us a clean extraction path if a module ever needs to become its own service (most likely: `tracking` and `notifications`).

### 2.3 Deployment Targets

| Component | Platform | Why |
|---|---|---|
| API (NestJS) | Railway | Postgres + Redis + service in one project, simple service discovery via private networking |
| Realtime (Socket.io) | Railway | Same project as API; sticky sessions handled via Railway's TCP proxy |
| Vendor Portal (Next.js) | Vercel | ISR for marketing pages, edge functions for auth callbacks, server components for dashboard |
| Background workers (BullMQ) | Railway | Same image as API with different start command; horizontal scale separate from API |
| Postgres | Railway Postgres | Managed, point-in-time recovery, automatic backups |
| Redis | Railway Redis | Queue + cache + Socket.io adapter |
| Object storage | Cloudflare R2 | S3-compatible, zero egress (we'll serve product images and ID scans) |
| CDN | Cloudflare | In front of R2 + custom domain |

iOS apps go to TestFlight → App Store. Cannabis apps are tricky on Apple — we'll discuss workarounds in §10.

---

## 3. Database Architecture

### 3.1 Design Principles

1. **PostgreSQL 16**, with extensions: `uuid-ossp`, `postgis` (geofencing + driver location), `pg_trgm` (product search), `pgcrypto` (column-level encryption for PII).
2. **UUIDv7** for primary keys (sortable, k-sortable indexes — better than UUIDv4 for our access patterns).
3. **Soft deletes** on every domain table (`deleted_at TIMESTAMPTZ`). Cannabis records are subject to multi-year retention.
4. **Audit columns everywhere**: `created_at`, `updated_at`, `created_by`, `updated_by`. Backed by triggers.
5. **Event-sourced order log** — separate `order_events` table that captures every state transition with actor + payload. This is our defense in an audit.
6. **Money as `NUMERIC(12,2)`**. Never `FLOAT`. Never JavaScript `number`.
7. **Multi-tenancy via row-level security** on tables that vendors touch. Dispensary staff can only see their own data.
8. **No cascading deletes on financial or compliance tables.** Ever.

### 3.2 Schema

I'll group tables by domain. SQL DDL is in `schema.sql` (separate artifact); this is the conceptual model.

#### Identity & Auth

```
users
  id (uuid pk)
  email (citext unique)
  phone (text unique, e.164)
  password_hash (text)
  role (enum: customer | budtender | manager | driver | admin | superadmin)
  status (enum: pending_kyc | active | suspended | banned)
  date_of_birth (date)        -- collected at signup, verified at KYC
  kyc_verified_at (timestamptz)
  kyc_provider_ref (text)     -- Persona inquiry ID
  mfa_secret (text, encrypted)
  created_at, updated_at, deleted_at

user_addresses
  id (uuid pk)
  user_id (fk users)
  label (text)                -- "Home", "Work"
  line1, line2, city, region, postal_code (text)
  location (geography(point))
  is_default (boolean)
  is_validated (boolean)      -- residential vs commercial, against USPS
  validated_at (timestamptz)

user_id_documents              -- encrypted at column level
  id (uuid pk)
  user_id (fk)
  type (enum: drivers_license | passport | state_id | military_id)
  document_number_hash (bytea)  -- hashed, never stored plaintext
  scan_image_key (text)         -- R2 object key, encrypted
  verified_at (timestamptz)
  expires_at (date)
  veriff_session_id (text)

sessions
  id (uuid pk)
  user_id (fk)
  refresh_token_hash (bytea)
  device_id (text)
  device_fingerprint (jsonb)
  expires_at (timestamptz)
  revoked_at (timestamptz)
```

#### Dispensaries & Staff

```
dispensaries
  id (uuid pk)
  legal_name, dba (text)
  license_number (text unique)   -- OCM license #, validated against state registry
  license_type (enum: retailer | microbusiness | mezzobusiness | medical_combo)
  license_expires_at (date)
  metrc_facility_id (text)
  pos_provider (enum: dutchie | flowhub | treez | greenbits | manual)
  pos_credentials_encrypted (bytea)
  address_id (fk addresses)
  delivery_polygon (geography(polygon))   -- store-defined service area
  hours_json (jsonb)            -- weekly schedule, MN hour ceilings enforced server-side
  is_accepting_orders (boolean)
  rating_avg (numeric(3,2))
  status (enum: onboarding | active | paused | terminated)
  created_at, updated_at, deleted_at

dispensary_staff
  id (uuid pk)
  dispensary_id (fk)
  user_id (fk)
  role (enum: budtender | manager | owner)
  permissions (jsonb)           -- granular feature flags
  invited_at, accepted_at

dispensary_bank_accounts        -- for Aeropay payouts
  id (uuid pk)
  dispensary_id (fk)
  aeropay_account_ref (text)
  last4 (text)
  status (enum: pending | verified | failed)
```

#### Catalog

```
product_categories
  id (uuid pk)
  slug (text unique)            -- flower, vapes, edibles, pre_rolls, concentrates, topicals, accessories
  display_name (text)
  parent_id (fk product_categories, nullable)

products                        -- catalog-level (shared across dispensaries)
  id (uuid pk)
  category_id (fk)
  brand (text)
  name (text)
  description (text)
  product_type (enum: flower | preroll | vape | edible | concentrate | tincture | topical | accessory)
  strain_type (enum: indica | sativa | hybrid | cbd, nullable)
  thc_mg_per_unit (numeric(10,3))  -- normalized for compliance math
  cbd_mg_per_unit (numeric(10,3))
  weight_grams_per_unit (numeric(10,3))
  serving_count (integer)        -- edibles
  thc_mg_per_serving (numeric(10,3))
  image_keys (text[])            -- R2 object keys
  search_vector (tsvector)       -- gin index for fast search
  created_at, updated_at

dispensary_listings              -- dispensary-specific availability & pricing
  id (uuid pk)
  dispensary_id (fk)
  product_id (fk)
  sku (text)                     -- dispensary's POS SKU
  price_cents (integer)
  compare_at_price_cents (integer)
  quantity_available (integer)   -- mirrored from POS
  metrc_package_tag (text)       -- current package being sold from
  last_synced_at (timestamptz)
  is_active (boolean)
  UNIQUE(dispensary_id, sku)

product_lab_results
  id (uuid pk)
  product_id (fk)
  lab_name (text)
  coa_document_key (text)        -- COA PDF in R2
  potency_thc, potency_cbd (numeric)
  contaminants_passed (boolean)
  tested_at (date)
  batch_id (text)
```

#### Cart & Orders

```
carts
  id (uuid pk)
  user_id (fk)
  dispensary_id (fk)             -- carts are scoped to one dispensary
  expires_at (timestamptz)       -- carts expire to release inventory holds
  created_at, updated_at

cart_items
  id (uuid pk)
  cart_id (fk, on delete cascade)
  listing_id (fk dispensary_listings)
  quantity (integer)
  unit_price_cents (integer)     -- snapshot price
  created_at, updated_at

orders
  id (uuid pk)
  short_code (text unique)       -- "DD-3F9A2K" for human reference
  user_id (fk)
  dispensary_id (fk)
  driver_id (fk users, nullable)
  delivery_address_id (fk)
  status (enum: see §3.3)
  status_changed_at (timestamptz)
  -- pricing snapshot
  subtotal_cents, cannabis_tax_cents, sales_tax_cents, delivery_fee_cents,
    driver_tip_cents, total_cents (integer)
  -- compliance snapshot at order creation
  compliance_check_payload (jsonb)   -- exact values validated at time of order
  -- timestamps
  placed_at, accepted_at, prepared_at, picked_up_at,
    delivered_at, canceled_at (timestamptz)
  -- pickup ID scan
  delivery_id_scan_ref (text)        -- Veriff session
  delivery_id_scan_passed (boolean)
  delivery_id_scan_at (timestamptz)
  -- post-delivery
  customer_rating (smallint)
  customer_review (text)
  -- audit
  created_at, updated_at

order_items
  id (uuid pk)
  order_id (fk)
  listing_id (fk)
  product_snapshot (jsonb)       -- denormalized at order time
  metrc_package_tag (text)
  quantity (integer)
  unit_price_cents (integer)
  thc_mg_total (numeric(12,3))   -- used by compliance validator
  cannabis_tax_cents (integer)
  sales_tax_cents (integer)

order_events                     -- immutable event log
  id (uuid pk)
  order_id (fk)
  event_type (text)              -- placed, accepted, prepped, dispatched, etc.
  actor_user_id (fk users, nullable)
  actor_role (text)
  payload (jsonb)
  occurred_at (timestamptz)
  -- never updated, never deleted

order_status_history
  id (uuid pk)
  order_id (fk)
  from_status, to_status (text)
  changed_by (fk users)
  reason (text)
  changed_at (timestamptz)
```

#### Payments & Ledger

```
payment_methods
  id (uuid pk)
  user_id (fk)
  type (enum: aeropay_ach | cash)
  aeropay_payment_method_ref (text)
  bank_name, last4 (text)
  is_default (boolean)
  status (enum: pending | active | failed | revoked)

payment_transactions
  id (uuid pk)
  order_id (fk)
  payment_method_id (fk)
  provider (enum: aeropay)
  provider_ref (text)            -- Aeropay txn ID
  amount_cents (integer)
  status (enum: initiated | authorized | settled | failed | refunded)
  failure_reason (text)
  initiated_at, settled_at, failed_at (timestamptz)

ledger_entries                   -- double-entry, never updated
  id (uuid pk)
  order_id (fk, nullable)
  payout_id (fk, nullable)
  account_type (enum: customer | dispensary | driver | platform_revenue |
                       cannabis_tax | sales_tax | aeropay_clearing)
  account_ref (uuid)             -- user_id, dispensary_id, etc.
  debit_cents, credit_cents (integer)  -- exactly one is non-zero
  description (text)
  occurred_at (timestamptz)
  created_at (timestamptz)
  -- CHECK ((debit_cents > 0) <> (credit_cents > 0))
  -- Daily reconciliation job ensures sum(debits) = sum(credits)

payouts                          -- to dispensaries and drivers
  id (uuid pk)
  recipient_type (enum: dispensary | driver)
  recipient_id (uuid)
  period_start, period_end (date)
  gross_cents, fees_cents, net_cents (integer)
  aeropay_payout_ref (text)
  status (enum: pending | processing | completed | failed)
  scheduled_for (date)
  completed_at (timestamptz)

refunds
  id (uuid pk)
  order_id (fk)
  amount_cents (integer)
  reason_code (text)
  reason_notes (text)
  initiated_by (fk users)
  provider_ref (text)
  status (enum: pending | completed | failed)
  created_at, completed_at
```

#### Dispatch & Tracking

```
drivers                          -- extends users where role='driver'
  id (uuid pk)
  user_id (fk unique)
  license_number_hash (bytea)
  vehicle_make, vehicle_model, vehicle_year (text/int)
  vehicle_plate (text)
  insurance_doc_key (text)
  background_check_passed_at (date)
  background_check_provider_ref (text)
  current_status (enum: offline | online | en_route_pickup | en_route_dropoff | unavailable)
  last_status_change_at (timestamptz)
  current_location (geography(point))
  current_location_updated_at (timestamptz)
  current_order_id (fk orders, nullable)
  rating_avg (numeric(3,2))
  total_deliveries (integer)

driver_shifts
  id (uuid pk)
  driver_id (fk)
  started_at, ended_at (timestamptz)
  starting_location (geography(point))
  total_miles (numeric)
  total_earnings_cents (integer)

driver_location_history          -- HOT TABLE — see §3.4 for partitioning
  id (bigserial pk)
  driver_id (fk)
  order_id (fk, nullable)
  location (geography(point))
  accuracy_meters (numeric)
  speed_mps (numeric)
  heading_deg (numeric)
  recorded_at (timestamptz)
  PARTITIONED BY RANGE (recorded_at)

dispatch_offers
  id (uuid pk)
  order_id (fk)
  driver_id (fk)
  offered_at (timestamptz)
  expires_at (timestamptz)        -- 30s default
  payout_estimate_cents (integer)
  distance_miles (numeric)
  status (enum: offered | accepted | declined | expired)
  responded_at (timestamptz)
```

#### Compliance & Traceability

```
compliance_checks
  id (uuid pk)
  check_type (enum: age | hours | per_transaction_limit | delivery_geofence | id_scan)
  subject_type (text)             -- 'order', 'cart', 'user'
  subject_id (uuid)
  passed (boolean)
  details (jsonb)
  performed_at (timestamptz)
  performed_by (fk users, nullable)

metrc_transactions
  id (uuid pk)
  order_id (fk)
  metrc_receipt_id (text)
  package_tags (text[])
  reported_at (timestamptz)
  status (enum: pending | reported | failed | reconciled)
  response_payload (jsonb)
  failure_reason (text)

age_verifications
  id (uuid pk)
  user_id (fk)
  context (enum: signup | delivery_handoff)
  order_id (fk, nullable)
  provider (enum: persona | veriff)
  provider_session_id (text)
  passed (boolean)
  passed_at (timestamptz)
  scan_image_key (text)           -- R2, encrypted, 7yr retention
```

#### Notifications & Misc

```
notifications
  id (uuid pk)
  user_id (fk)
  channel (enum: push | sms | email)
  template_key (text)
  payload (jsonb)
  sent_at (timestamptz)
  delivered_at (timestamptz)
  read_at (timestamptz)
  provider_ref (text)

push_tokens
  id (uuid pk)
  user_id (fk)
  device_id (text)
  apns_token (text)
  platform (enum: ios | web)
  is_active (boolean)

audit_log                         -- everything sensitive
  id (uuid pk)
  actor_user_id (fk)
  action (text)                   -- 'user.suspend', 'order.refund', etc.
  resource_type, resource_id (text)
  changes (jsonb)                 -- before/after
  ip_address, user_agent (text)
  occurred_at (timestamptz)
```

### 3.3 Order State Machine

```
              ┌─→ canceled (by customer, pre-acceptance only)
              │
   placed ────┼─→ accepted ──→ prepping ──→ ready_for_pickup
              │      │             │              │
              │      └─→ rejected  │              ▼
              ↓                    │       awaiting_driver
   payment_failed                  │              │
                                   ↓              ▼
                              canceled       driver_assigned
                              (by store)         │
                                                 ▼
                                          en_route_pickup
                                                 │
                                                 ▼
                                          picked_up
                                                 │
                                                 ▼
                                          en_route_dropoff
                                                 │
                                                 ▼
                                          arrived_at_dropoff
                                                 │
                                                 ▼
                                          id_scan_pending
                                                 │
                                                 ▼
                                          id_scan_passed ──→ delivered
                                                 │
                                                 ▼
                                          id_scan_failed ──→ returned_to_store
```

Implemented in code as XState machines that mirror the DB enum. Server is authoritative; clients can only request transitions. Every transition writes an `order_event`.

### 3.4 Partitioning & Performance

- `driver_location_history`: declarative range partitioning by week. We'll write ~5GB/month at scale. Hot partition stays in memory; older partitions get detached after 90 days and archived to R2 as Parquet for OCM exports.
- `order_events`: monthly partitioning, same pattern.
- `notifications`: monthly partitioning.
- `audit_log`: monthly partitioning, 7-year retention (OCM rule).

Indexes:

- `dispensary_listings (dispensary_id, is_active) WHERE quantity_available > 0` — homepage feed
- `products` GIN on `search_vector` — search
- `orders (dispensary_id, status, placed_at DESC)` — vendor order queue
- `orders (user_id, placed_at DESC)` — customer history
- `drivers USING GIST (current_location) WHERE current_status = 'online'` — dispatch
- `dispensaries USING GIST (delivery_polygon)` — coverage lookups

### 3.5 Row-Level Security

Enabled on `orders`, `order_items`, `cart_items`, `dispensary_listings`, `payouts`, `payment_transactions`.

Example policy (orders):

```sql
CREATE POLICY orders_vendor_isolation ON orders
  FOR ALL TO vendor_role
  USING (dispensary_id = current_setting('app.current_dispensary_id')::uuid);
```

The API sets `app.current_dispensary_id` per request via `SET LOCAL`. Defense in depth — even a SQL injection can't cross tenant boundaries.

---

## 4. API Design

### 4.1 Style

- **REST** for resource CRUD, with consistent shape: `/v1/{resource}` and `/v1/{resource}/{id}/{action}`.
- **GraphQL** for read-heavy customer-facing screens where over-fetching matters (dispensary feed, product detail). Mutations remain REST.
- **WebSocket** (Socket.io) for live order tracking and dispatch.
- JSON request/response, snake_case in payloads (matches DB), camelCase only in TypeScript types.
- API versioned in URL: `/v1/...`. Major bumps only for breaking changes; deprecate with 6-month sunset.

### 4.2 Auth

- OAuth 2.0 password grant for first-party clients (we own all three).
- Access token: JWT, 15 min TTL, RS256.
- Refresh token: opaque, stored hashed, 30 day TTL, rotated on every use.
- MFA required for `manager`, `owner`, `admin`, `superadmin` roles.
- All write endpoints require a fresh access token (≤15 min). Sensitive ones (refund, license edit) re-prompt for password.

### 4.3 Key Endpoints (REST)

**Customer (DankDash iOS)**

```
POST   /v1/auth/register
POST   /v1/auth/login
POST   /v1/auth/refresh
POST   /v1/auth/logout
POST   /v1/identity/kyc/start         -> returns Persona inquiry URL
POST   /v1/identity/kyc/webhook       (Persona → us)

GET    /v1/dispensaries?lat=&lng=     -- only stores serving that point
GET    /v1/dispensaries/:id
GET    /v1/dispensaries/:id/menu
GET    /v1/products/:id
GET    /v1/products/search?q=

POST   /v1/cart                       -- create cart for dispensary
GET    /v1/cart/:id
POST   /v1/cart/:id/items
PATCH  /v1/cart/:id/items/:itemId
DELETE /v1/cart/:id/items/:itemId
POST   /v1/cart/:id/validate          -- compliance preview
POST   /v1/cart/:id/checkout          -- creates order, returns payment intent

GET    /v1/orders                     -- mine
GET    /v1/orders/:id
POST   /v1/orders/:id/cancel
POST   /v1/orders/:id/rate

GET    /v1/payment-methods
POST   /v1/payment-methods/aeropay/link
DELETE /v1/payment-methods/:id

GET    /v1/addresses
POST   /v1/addresses
```

**Vendor (DankDash for Business)**

```
GET    /v1/vendor/orders?status=&from=&to=
GET    /v1/vendor/orders/:id
POST   /v1/vendor/orders/:id/accept
POST   /v1/vendor/orders/:id/reject
POST   /v1/vendor/orders/:id/prepped
POST   /v1/vendor/orders/:id/ready
POST   /v1/vendor/orders/:id/handoff  -- driver confirmed pickup

GET    /v1/vendor/listings
PATCH  /v1/vendor/listings/:id
POST   /v1/vendor/pos/sync            -- manual trigger
POST   /v1/vendor/pos/webhook         (Dutchie/Flowhub → us)

GET    /v1/vendor/analytics/sales?period=
GET    /v1/vendor/analytics/products
GET    /v1/vendor/payouts
GET    /v1/vendor/staff
POST   /v1/vendor/staff/invite
```

**Driver (DankDasher)**

```
POST   /v1/driver/shift/start
POST   /v1/driver/shift/end
POST   /v1/driver/status              -- online | offline | break

POST   /v1/driver/offers/:id/accept
POST   /v1/driver/offers/:id/decline
GET    /v1/driver/current-route

POST   /v1/driver/orders/:id/pickup-confirm
POST   /v1/driver/orders/:id/arrived
POST   /v1/driver/orders/:id/id-scan  -- Veriff session result
POST   /v1/driver/orders/:id/complete

POST   /v1/driver/location            -- batched location updates (handled mostly via WS)
GET    /v1/driver/earnings?period=
```

### 4.4 Realtime (Socket.io)

Namespaces:

- `/customer` — order updates, driver location stream
- `/vendor` — new orders, status changes
- `/driver` — offers, route updates

Auth via JWT in `auth` payload on connect. Server validates and joins per-user rooms.

Events (server → client):

| Event | Audience | Payload |
|---|---|---|
| `order:created` | vendor room | `OrderSummary` |
| `order:status_changed` | customer + vendor + driver | `{ orderId, from, to, at }` |
| `driver:location` | customer (their order's driver only) | `{ lat, lng, heading, eta }` |
| `offer:new` | specific driver | `OfferPayload` |
| `offer:expired` | specific driver | `{ offerId }` |

Events (client → server):

| Event | Sender | Purpose |
|---|---|---|
| `driver:location:update` | driver | location ping (~5s while active) |
| `driver:heartbeat` | driver | keep-alive |

Location ingestion is rate-limited at 1 msg/sec per driver. Writes go through Redis Streams → consumer writes to `driver_location_history` in batches.

### 4.5 Error Format

```json
{
  "error": {
    "code": "COMPLIANCE_LIMIT_EXCEEDED",
    "message": "Cart exceeds the 800mg THC limit for edibles per transaction",
    "details": {
      "limit_mg": 800,
      "cart_mg": 950
    },
    "request_id": "req_01HVK..."
  }
}
```

Error codes are stable, machine-readable, documented. Never expose stack traces.

---

## 5. iOS App Specs

### 5.1 DankDash (Consumer)

**Stack**

- SwiftUI, iOS 17+
- The Composable Architecture (TCA) for state management
- `swift-openapi-generator` for typed API client from our OpenAPI spec
- Mapbox SDK for live tracking (Apple Maps doesn't offer good live polyline updates)
- Persona iOS SDK for KYC
- KeychainAccess for tokens
- SQLite (GRDB) for offline cart cache

**Architecture**

```
Features/
  Onboarding/         (age gate, signup, KYC)
  DispensaryFeed/     (home, search, filters)
  ProductCatalog/     (menu browsing per dispensary)
  Cart/               (line items, compliance preview)
  Checkout/           (address, payment, place order)
  OrderTracking/      (status timeline, live map)
  OrderHistory/
  Account/
  Wallet/             (payment methods, Aeropay link)
Core/
  Networking/         (APIClient, AuthInterceptor, RetryPolicy)
  Realtime/           (SocketClient wrapper)
  Storage/            (Keychain, GRDB)
  Compliance/         (client-side preview validators)
  Analytics/          (event taxonomy, PostHog client)
DesignSystem/
  Colors, Typography, Spacing, Components
```

**Color Palette**

```swift
enum DankColor {
  static let primary = Color(hex: "1A4314")    // rich dark green
  static let primaryDark = Color(hex: "0E2A0B")
  static let cream = Color(hex: "F5EFE0")
  static let accent = Color(hex: "C9A961")     // muted gold
  static let glass = Color.white.opacity(0.08) // frosted overlays
  static let semantic = (success: Color(hex: "2D7A2A"),
                         warning: Color(hex: "B8860B"),
                         danger:  Color(hex: "8B2C2C"))
}
```

**Key Screens & Behaviors**

1. **Age Gate** — modal on first launch, before anything else renders. DOB picker. Stores acknowledgment locally (not legally binding alone) and triggers Persona KYC on first checkout. Persona returns an inquiry ID we associate with the user record.

2. **Dispensary Feed** — `LazyVStack` of `DispensaryCard`. Sectioned: "Delivering to you now", "Top rated", "New on DankDash", "Closing soon". Each card has frosted-glass overlay (`.background(.ultraThinMaterial)`) over a hero image, with ETA badge and status pill.

3. **Storefront** — sticky category tab bar, products in 2-column grid with strain-type indicator (sativa/indica/hybrid color dots), THC % and price. Tap → product detail with COA link.

4. **Compliance Cart** — when a user adds an item, the cart computes:
   - total flower grams
   - total concentrate grams
   - total edible THC mg
   Each against MN limits. If adding would exceed, the "Add" button shows "Over MN limit" and the offending category is highlighted with the actual numbers. **The validation is duplicated server-side at checkout** — client is just for UX.

5. **Checkout** — address selection (must be in dispensary delivery polygon, validated live), payment method (Aeropay or COD if dispensary supports it), tip slider (default 15%), legal acknowledgment ("I am 21+, this product will not leave my private residence in violation of law, …"), place order button.

6. **Live Tracking** — full-screen `MapView` with custom dark style. Driver marker (dark green sedan SVG, rotated by heading). Polyline from current location to destination, fetched from Mapbox Directions API every 30s. Bottom sheet with status timeline, driver name + photo + plate, contact button (masked Twilio number, never reveals real driver phone).

7. **Post-delivery** — rating sheet appears 5 min after `delivered`. 1-5 stars + optional review for both dispensary and driver.

**Push notifications via APNs:**
- order accepted, prepping, ready, picked up, arriving (1 mi out), arrived, completed
- payment failed, refund issued
- new dispensary near you (weekly, opt-in)

### 5.2 DankDasher (Driver)

**Stack** — same as consumer, plus:
- CoreLocation in `kCLAuthorizationStatusAuthorizedAlways` mode with significant-change + standard updates
- AVFoundation for ID scan camera
- Veriff iOS SDK for verified scans
- Background tasks for location continuation when app is backgrounded (need `location` background mode entitlement — Apple approves these for delivery drivers)

**Architecture** — same shape as consumer.

**Key Screens**

1. **Onboarding/Compliance** — uploads license, vehicle insurance, vehicle registration. Triggers Checkr background check. Admin approves manually before account activates.

2. **Map / Home (Online)** — full-screen dark map. Driver toggle in top-right (`Online`/`Offline`). When online, demand heatmap overlay (semi-transparent hex grid colored by order density, fetched every 60s from `/v1/driver/heatmap`).

3. **Offer Card** — when an offer arrives, a slide-up sheet shows: payout estimate, pickup dispensary + address + distance, dropoff distance, total miles, 30-second countdown ring. Accept/Decline. Haptic ping on arrival.

4. **Active Route** — turn-by-turn navigation. We use Apple Maps for navigation (free, works offline well, drivers know it). When approaching pickup, screen flips to "At Pickup" with `Confirm Pickup` button. Same flow for dropoff.

5. **ID Scan at Dropoff** — full-screen Veriff session. Verifies:
   - ID is government-issued
   - Photo matches face (live selfie)
   - Age ≥ 21
   - ID matches order recipient name (configurable — some dispensaries allow handoff to anyone over 21 at the address; default is strict match)
   Result returns to app via callback. On pass, `Delivery Complete` button unlocks. On fail, driver sees options: re-scan, contact support, return to store.

6. **Earnings Wallet** — daily/weekly summary, tip breakdown, Aeropay payout schedule, cashout button.

**Background behavior** — location updates every 5s while on active route, every 30s while online and idle. We rotate `significantLocationChange` for battery preservation when idle, then ramp up on offer acceptance.

### 5.3 Shared iOS Concerns

- All API calls go through `APIClient` with token refresh interceptor, exponential backoff retry (network errors only, never on 4xx).
- Network layer uses async/await.
- Offline-tolerant for read screens (last successful response cached in GRDB, shown with stale indicator). Write actions queue and replay (Outbox pattern).
- Crash reporting via Sentry.
- Analytics via PostHog (self-hosted on Railway to avoid cannabis-industry vendor refusals).

---

## 6. Vendor Portal (DankDash for Business)

### 6.1 Stack

- Next.js 15, App Router, React Server Components
- TypeScript strict
- Tailwind CSS + shadcn/ui (Radix primitives, accessible by default)
- TanStack Query for client state where SSR isn't enough
- Zod for runtime validation, end-to-end (form → API → DB shape)
- Auth.js (NextAuth v5) with custom credentials provider against our API
- Pusher Channels alternative: we'll use our own Socket.io service via `socket.io-client`
- Recharts for dashboards
- Deployed on Vercel, with environment-specific preview URLs

### 6.2 Information Architecture

```
/login
/two-factor
/dashboard                     -- KPIs, alerts
/orders                        -- live queue + history
  /orders/[id]
/menu                          -- inventory & pricing
  /menu/[productId]
/staff
  /staff/invite
/payouts
/analytics
  /analytics/sales
  /analytics/products
  /analytics/customers
/settings
  /settings/store              -- hours, delivery polygon, branding
  /settings/integrations       -- POS, Metrc, Aeropay
  /settings/compliance         -- license docs, expirations
```

### 6.3 Live Order Queue Design

The signature screen. Layout: four columns — **New**, **Prepping**, **Ready**, **Out for Delivery**. Cards drag horizontally between columns (with confirmation on backwards moves). Each card shows:

- Order short code, customer first name + last initial
- Item count, subtotal
- Time since placed (turns yellow at 5 min, red at 10 min)
- Dasher status badge (if assigned): "Dasher 3 min away"
- Tap → full detail drawer

New orders trigger a chime (configurable, can be muted per-session but not per-account — we want budtenders to hear orders). Browser notification permission requested on first session.

Real-time updates via Socket.io. The page works without WS (polls every 15s as fallback) but degrades the experience.

### 6.4 Menu Sync

Default: the POS is the source of truth. Vendors hit "Connect POS" in Settings → Integrations → OAuth flow with Dutchie/Flowhub/Treez → we receive product, inventory, pricing, batches.

Vendors can override on a per-listing basis: hide from DankDash, override price (with reason), override description/photo. Overrides are stored alongside the synced data and reapplied on each sync.

Sync runs every 5 min via cron, plus webhook-triggered when the POS supports it.

### 6.5 Performance Dashboard

Cards:
- Today's revenue (vs same DOW last week)
- Orders today, AOV
- Average prep time
- Top 5 strains this week
- Reorder rate
- Average customer rating

Charts use Recharts with our color tokens. Date range picker (today, 7d, 30d, custom). All queries run as server components for first paint; client-side TanStack Query rehydrates for interactions.

### 6.6 Accessibility & Trust

- WCAG 2.1 AA target. Tested via axe-core in CI.
- High-contrast mode toggle (cannabis retail floors have variable lighting).
- All actions confirmable; destructive ones require typed confirmation.
- Audit log surfaced in Settings ("Who changed what, when") — vendors love being able to prove their own innocence.

---

## 7. External Integrations

### 7.1 POS Systems

| POS | Auth | Sync direction | Webhook |
|---|---|---|---|
| Dutchie | OAuth 2.0 | inventory ↓, sales ↑ | yes |
| Flowhub | API key | inventory ↓ | poll only |
| Treez | OAuth 2.0 | inventory ↓, sales ↑ | yes |
| GreenBits | API key | inventory ↓ | poll only |

We abstract behind a `PosAdapter` interface. New POS = implement adapter, add to factory, add credential UI.

### 7.2 Metrc (State Traceability)

Every sale to a customer must be reported with the package tag(s). On `delivered` state transition, a BullMQ job pushes the sale to Metrc:

```
POST https://api-mn.metrc.com/sales/v2/receipts
```

We store the receipt ID. A nightly reconciliation job compares our `orders` table to Metrc's `/receipts/active` and surfaces discrepancies in the admin console.

Failures retry with exponential backoff up to 24 hours; persistent failures escalate to admin email.

### 7.3 Aeropay (Payments)

Pay-by-bank ACH. Customer links bank via Aeropay's hosted flow (Plaid under the hood). At checkout we create a payment intent, get a `payment_id`, customer confirms in-app, we receive a webhook on settlement.

Funds flow: customer → Aeropay clearing → us (platform fee held) → dispensary + driver (T+1).

Aeropay is cannabis-compliant where Stripe and Square aren't. We have a backup integration path documented for Hypur in case of Aeropay outages.

### 7.4 KYC & Age Verification

- **Persona** for signup KYC. Hosted flow, we receive a webhook with verification result. Stored `kyc_provider_ref` lets us reopen the inquiry later for re-verification.
- **Veriff** for delivery-time ID scans. SDK-driven, runs inside the driver app, returns a session result we record on the order.

We use two providers deliberately — different fraud signatures, and outage isolation.

### 7.5 Maps

- **Mapbox** for customer live tracking (better SDK customization).
- **Apple Maps** for driver turn-by-turn (free, native, drivers know it).
- **Google Geocoding** for address validation (most accurate). Wrapped behind `GeocodingService` so we can swap.

### 7.6 Communications

- **Twilio** for SMS (order updates, masked driver-customer calls via Twilio Proxy).
- **Resend** for transactional email.
- **APNs** direct for iOS push.

---

## 8. Security & Privacy

### 8.1 Data Classification

| Tier | Examples | Handling |
|---|---|---|
| Public | product names, dispensary listings | normal |
| Internal | order metadata, prices | normal |
| Confidential | customer addresses, phone numbers | TLS in transit, encrypted at rest |
| Restricted | ID scans, DOB, bank refs, license numbers | column-level encryption with `pgcrypto`, separate KMS key |

Restricted data is encrypted using envelope encryption — column key wrapped by a master key stored in Railway's secret manager. Decryption happens in the app layer, never in the database (so DBA access alone doesn't expose plaintext).

### 8.2 Compliance with Privacy Laws

Minnesota doesn't (yet) have a state-level consumer privacy act, but we design as if it does:

- Full data export endpoint per user (`GET /v1/me/export`).
- Deletion request flow — with a 30-day cooling-off period, and we retain only what we're legally required to (orders for 5 years per OCM; financial records for 7 years per IRS).
- Cookie consent on the web portal (more about vendor employees than customers, but still).

### 8.3 Threat Model Highlights

- **Account takeover** — MFA required for staff/admin; rate-limited login; anomaly detection on geo/device.
- **Fake orders to scrape inventory** — bot detection at the API edge (Cloudflare Turnstile on signup, rate limits per IP and per device).
- **Driver going rogue** (selling at retail prices then keeping product) — Metrc package tags reconcile nightly. Outliers flagged.
- **Customer ID fraud at delivery** — Veriff liveness check (not just photo match), photo of ID and selfie stored, driver can escalate.
- **SQL injection / IDOR** — parameterized queries everywhere, RLS as defense in depth.
- **Token theft** — short-lived JWTs, refresh tokens hashed in DB, device binding via fingerprint.
- **Insider threat** — full audit log, separation of duties (no single admin can issue a refund AND approve their own payout).

### 8.4 Logging & Monitoring

- Structured logs (pino) → Railway logs → forwarded to Logtail/Better Stack
- Metrics: OpenTelemetry → Grafana Cloud
- Errors: Sentry across all clients and server
- Uptime: BetterStack monitors on key endpoints
- On-call: PagerDuty, with rotation between founders + senior engineers

Alerts that page someone at 3 AM:
- API p95 latency > 2s for 5 min
- Order placement error rate > 1%
- Metrc sync failure rate > 5% in 1 hour
- Aeropay webhook gap (no messages in 30 min during operating hours)
- Driver location ingestion lag > 60s

---

## 9. Testing Strategy

| Layer | Tool | Coverage Target |
|---|---|---|
| Unit (backend) | Vitest | 80% on services, 100% on `compliance/` |
| Integration | Vitest + Testcontainers (Postgres + Redis) | All API routes happy path + key failures |
| Contract | Pact | Between API and each iOS app |
| E2E (vendor portal) | Playwright | Critical flows: login, accept order, mark ready |
| E2E (iOS) | XCUITest | Smoke: signup, browse, checkout, track |
| Load | k6 | 1000 concurrent customers, 100 drivers, 30 dispensaries |
| Compliance | Custom suite | Every MN rule has a test that fails closed |

The compliance suite is the most important and runs on every commit. Sample tests:

- `cart with 801mg total edible THC must be rejected`
- `order placed at 2:01 AM must be rejected`
- `delivery to Hudson, WI must be rejected (geofence)`
- `order without passed KYC must be rejected`
- `delivery completion without successful Veriff scan must be rejected`

If any compliance test fails, deploys are blocked.

---

## 10. Deployment & Operations

### 10.1 Environments

- `dev` — local, docker-compose
- `staging` — Railway, mirrors prod, sanitized data
- `prod` — Railway

Each Railway project per environment. Vercel projects mirror.

### 10.2 CI/CD

GitHub Actions:

1. Lint (eslint, prettier, swiftformat)
2. Type check (tsc, swift build)
3. Unit + integration tests
4. Compliance tests
5. Build Docker image, push to Railway registry
6. Deploy to staging
7. Run smoke tests against staging
8. Manual approval → prod
9. Vercel auto-deploys vendor portal on `main` push (after CI pass)

Database migrations via Prisma Migrate (or Drizzle Kit — see §11), applied on deploy with advisory locks to prevent races between API instances.

iOS: TestFlight builds on every merge to `main` via Xcode Cloud or Fastlane on GitHub Actions.

### 10.3 Backups & DR

- Postgres: Railway's automated point-in-time backups, plus nightly logical dumps to R2 (encrypted).
- R2: versioning enabled, lifecycle rules to Glacier-equivalent for old files.
- Restore drills quarterly.
- RTO: 1 hour. RPO: 5 minutes.

### 10.4 Apple App Store Strategy

Cannabis apps live in a gray zone. Apple's guidelines (1.4.3) prohibit "facilitating the sale of marijuana." The workaround that has actually shipped (e.g., Eaze, Dutchie pre-acquisition):

1. The DankDash consumer app does **not** allow purchases through itself. We use a "menu-only" mode in the iOS build that displays products but redirects checkout to a Safari web view on `app.dankdash.com`. The web view handles checkout, payment, and order tracking.
2. The DankDasher driver app is a B2B utility for licensed delivery drivers and ships under a B2B/enterprise account (Apple Business Manager) or via direct distribution. We provision it to drivers, not the public.
3. The vendor portal is web-only — no iOS issue.

This is annoying but it's the proven path. We design the consumer app accordingly: tappable menu, "Continue to checkout in browser" hand-off, with the auth session passed via a one-time token in the URL so the user doesn't re-login.

If/when Apple changes policy, we flip a feature flag and enable in-app checkout for new builds.

### 10.5 Cost Estimate (year 1, ~5k orders/month)

| Item | Monthly |
|---|---|
| Railway (API + workers + realtime + Postgres + Redis) | $200 |
| Vercel Pro | $20 |
| Cloudflare R2 (1 TB stored, mostly free egress) | $15 |
| Mapbox (100k map loads, directions) | $50 |
| Aeropay | volume-based, ~2.5% of GMV |
| Persona | $1.50/verified user |
| Veriff | $1.20/scan |
| Metrc | per-state fee (~$40) |
| Twilio | $50 |
| Resend | $20 |
| Sentry | $26 |
| PostHog (self-host) | included in Railway |
| **Fixed total** | **~$450/mo** |

Variable costs scale with GMV. At $250k GMV/month, total infra+third-party runs ~$8k including Aeropay fees.

---

## 11. ORM & Migrations

**Drizzle ORM** for the backend. Rationale:

- Type-safe and zero-runtime (it's a query builder, not a heavy ORM)
- First-class Postgres support, including PostGIS via custom types
- Migrations are generated SQL files — easy to review, easy to hand-tune
- Plays nicely with serverless if we ever split out edge functions

Prisma was the other contender; rejected because PostGIS support requires raw queries anyway, and we want the migration files to be reviewable SQL.

---

## 12. Roadmap & Phasing

### Phase 1 — MVP (months 0–3)

- Auth, KYC, customer signup
- Vendor onboarding (manual approval)
- Catalog, single-dispensary launch (Twin Cities pilot)
- Cash on delivery only, payment via Aeropay link sent post-order
- Order placement, vendor accept/prep/ready, driver dispatch + ID scan
- Live tracking
- Metrc reporting

### Phase 2 — Scale (months 3–6)

- Multi-dispensary go-live
- Aeropay in-flow checkout
- Vendor analytics dashboard
- Driver heatmap
- Customer reorder flow
- Refunds & disputes

### Phase 3 — Optimization (months 6–12)

- Smart driver batching (multiple orders, one route)
- Personalized recommendations (collaborative filtering)
- Subscription / loyalty
- Catering / pre-order for events (consumption permits permitting)
- API for third-party dispensary integrations beyond the big 4 POS

---

## 13. Open Decisions for Founder Review

1. **Driver employment model** — 1099 contractors (faster scale, lower benefits cost) vs W-2 (better control, retention). Recommendation: 1099 with optional benefits stipend. Legal review required, especially given recent shifts in gig classification law.

2. **Native vs. web for vendor** — locked to web. Confirmed.

3. **MSO / chain dispensaries** — do we support a corporate-level account that manages multiple locations under one license group? Recommendation: yes, but Phase 2.

4. **Cash payments** — operationally messy (driver carries cash, change, reconciliation) and a robbery target. Recommendation: launch ACH-only, add cash later only if vendor demand is significant.

5. **Pre-rolls / bundles** — does the compliance calculator need to break a "1g pre-roll pack of 5" into 5g of flower equivalent? Yes, and the catalog schema supports it via `weight_grams_per_unit × quantity`. Edge case: infused pre-rolls count toward both flower AND concentrate limits — needs a product-type flag.

---

*End of specification.*
