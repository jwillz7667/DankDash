# DankDash — phase progress

A one-paragraph entry per completed phase. Newest first. Source of truth for
"what's actually done" — read this before claiming a feature exists.

## Conventions

- Each entry: phase number + title, completion date (UTC), commit range, and a
  short summary of what landed and what was deliberately deferred.
- "Deferred to Phase N" is preferred over "TODO" — every gap should have a
  named home further down the plan.
- If a phase ships partial scope, mark it `partial` and list the missing
  Definition-of-Done items so the next session knows what to pick up.

---

## Phase 6 — Payments & Aeropay

_Status: complete (2026-05-18). Branch: `phase/06-payments`._

What landed:

- **`@dankdash/aeropay` package** (`packages/aeropay/`) — typed client for Aeropay's bank-link / payment / refund / payout APIs. OAuth2 client-credentials flow with a pluggable token cache (in-memory default, Redis impl in `apps/api`) so two API replicas don't stampede the token endpoint. Every mutation accepts an `idempotencyKey` and forwards it as the `Idempotency-Key` header — required for the payment / payout retry contract upstream. All request + response bodies validated by Zod schemas; a single `AeropayError` discriminated union carries `code` + `statusCode` + the parsed upstream error so callers can decide retry vs surface-to-user. Webhook HMAC verifier (`verifyWebhookSignature`) reads `t=<unix>,v1=<hex>` from the `Aeropay-Signature` header, recomputes `HMAC-SHA256(secret, "${t}.${rawBody}")`, rejects on ±5min skew, and uses `timingSafeEqual` on the digest compare so signature checks don't leak timing. 100% line coverage. Public surface is the barrel — deep imports forbidden.
- **`PaymentMethodsModule`** (`apps/api/src/modules/payments/`) — `GET /v1/payment-methods` lists the caller's saved methods (bank account refs only, never the raw account number), `POST /v1/payment-methods/aeropay/link` exchanges a short-lived link token for a stored bank-account reference, `DELETE /v1/payment-methods/:id` soft-removes. The Redis token cache lives here (`redis-token-cache.ts`) and is wired into the Aeropay client via DI; the `RedisTokenCache` writes with `SET ... EX` so expired tokens are GC'd by Redis rather than a sweeper job.
- **Payment lifecycle wired into the existing checkout transaction** — the Phase 5 stub `pi_stub_<shortCode>` is replaced by a real `aeropay.createPayment` call inside the checkout txn, keyed by `payment:<orderId>` so a network retry coalesces upstream. `payment_transactions.provider_ref` now stores the real Aeropay payment id; `status` flows `initiated` → `authorized` → `settled` (or `failed`) driven by the webhook. On `payment.settled` the distribution ledger is written: customer-receivable DR cleared by aeropay_clearing CR for the placement leg, then the settlement-clearing pair + the distribution pair (dispensary CR for share, platform_fee CR for the 15% take, driver CR for tip, gross-receipts tax CR, sales tax CR, refund_reserve CR for 2.5% of dispensary share). Total per-order DRs after settle = `3 × orderTotal` (placement + settlement-clearing + distribution). Settlement formula corrected vs spec §6.4: the dispensary share line subtracts discount in addition to platform fee + driver tip + tax, otherwise double-entry breaks — guarded by memory `settlement_dispensary_share.md`.
- **`AeropayWebhookController`** (`POST /v1/payment-methods/aeropay/webhook`) — raw-body capture via a Fastify content-type parser registered for `application/json` so the HMAC verifier sees byte-exact input (the JSON the auto-parser produces is not a stable serialization). Public route (no JWT — Aeropay calls it), per-IP rate-limited. Forged signature → 401, body-not-JSON → 400. Idempotency via `webhook_events_processed` (Phase 6.7): every successful dispatch inserts `(event_id, event_type, processed_at)` inside the same txn that mutates `payment_transactions` + writes the ledger; a replay finds the row and logs `webhook replay ignored` without re-running any side effect.
- **`webhook_events_processed` table** (`packages/db/src/migrations/0010_webhook_events_processed.sql`) — `event_id` PK, `event_type` text, `processed_at` timestamptz default `NOW()`. The Phase 6.7 cleanup cron (`apps/workers/src/jobs/webhook-events/cleanup.job.ts`) runs at 02:00 America/Chicago daily and deletes rows older than 30 days — Aeropay's replay window is 7 days, so 30d is a safe operational floor.
- **Refunds with $50 admin-approval gate** — `POST /v1/vendor/orders/:id/refund` (vendor-scoped) initiates; if `amountCents ≤ 5000` the refund auto-completes inline (Aeropay `refundPayment` + 2 reverse-ledger entries DR refund_reserve / CR customer-receivable + flip `payment_transactions.status` to `partially_refunded`), otherwise the row stays `pending_admin_approval`. `POST /v1/admin/refunds/:id/approve` (admin role on JWT) finalizes — separation-of-duties enforced: the approver cannot be the initiator (422 `VALIDATION_FAILED`), checked in-service. `refunds.approved_by` FKs to `users.id`.
- **Daily payouts cron** (`apps/workers/src/jobs/payouts/`) — fires at 03:00 America/Chicago for the previous Central calendar day, half-open window `[periodStart, periodEnd)` in UTC. Per dispensary: gross = sum of CR entries on `account_type='dispensary'` in window; refund draw = sum of DR entries on `account_type='refund_reserve'` in window; net = gross − refund draw. If `aeropay_account_ref IS NULL` → payout row inserted with `status='failed'`, `failure_reason='dispensary_bank_account_not_linked'`, no Aeropay call. Else → `aeropay.createPayout` with `idempotencyKey='payout:<payouts.id>'`, status flips to `processing` on success. `payouts` table has a uniqueness constraint on `(recipient_type, recipient_id, period_start_date)` so a re-run for the same period short-circuits via `createIfAbsent` — no duplicate insert, no second Aeropay call. Driver payouts ride the same job through the `driver` account type.
- **Phase 6.8 integration tests** against the real Postgres+PostGIS testcontainer:
  - `apps/api/test/integration/payments.webhook.test.ts` (4 tests) — full lifecycle (checkout → `payment.authorized` → `payment.settled` → balanced 6+ ledger rows summing to `3 × total` debits = credits), forged signature → 401 (placement entries unchanged), replay of `payment.settled` is idempotent (single distribution leg), and an invariant test that sums debits/credits across many random orders.
  - `apps/api/test/integration/payments.refund.test.ts` (3 tests) — auto-approve small refund (≤$50) completes inline with 2 reverse-ledger entries and flips `payment_transactions` to `partially_refunded`; vendor >$50 stays `pending_admin_approval` then a different-user admin approves and finalizes; separation-of-duties → admin = initiator returns 422 `VALIDATION_FAILED` and the row stays pending. Admin approve calls drop `content-type` so Fastify's "Body cannot be empty when content-type is application/json" guard doesn't trip on the bodyless POST.
  - `apps/workers/test/integration/payouts.job.test.ts` (4 tests, new vitest config + global-setup at `apps/workers/test/`) — net math (gross 10000 − refund_reserve 2500 = 7500 dispatched with `idempotencyKey=payout:<payouts.id>`), no-bank skip path (status='failed', failure_reason='dispensary_bank_account_not_linked', zero Aeropay calls), idempotency on re-run (no duplicate row, no second Aeropay call), and window boundary exclusion (entries at the exact `periodEnd` UTC excluded, before-window excluded).
- **Test isolation fixes** — `webhook_events_processed` added to the TRUNCATE lists in `apps/api/test/integration/db.ts` and `packages/db/src/seed.ts` so dedup state from a prior test doesn't bleed into the next.

Definition-of-Done verification:

- Aeropay client typed end-to-end (Zod schemas, discriminated error union, idempotency-key contract). 100% line coverage on `@dankdash/aeropay`.
- All payment endpoints reachable: list / link / delete payment methods, webhook ingest, vendor refund, admin refund approve.
- Webhook signature verification working — HMAC-SHA256 over `${t}.${rawBody}`, ±5min skew, `timingSafeEqual` compare. Forged signature integration-tested.
- Ledger double-entry invariant verified by `payments.webhook.test.ts` random-sample check (debits = credits per order, total DRs = `3 × orderTotal` after settle).
- Refund flow with admin approval — auto-approve ≤$50, separation-of-duties on >$50, all three paths integration-tested.
- Payout cron functional + idempotent + boundary-correct, integration-tested against the real DB.
- 100% line coverage on `packages/aeropay`; the `payments` module is at ≥95% with the new integration suite — last remaining gaps are error branches that require provoking Aeropay-side 5xx, which the unit suite covers via fake throws.
- `pnpm typecheck` — 24/24 tasks succeed.
- `pnpm lint` — 16/16 tasks succeed, zero warnings.
- `pnpm test` — 24/24 tasks succeed (901/901 apps/api tests pass; 30/30 apps/workers tests pass including the 4 new payouts integration tests).
- `pnpm --filter @dankdash/api build` — produces `dist/main.js`.
- Branch `phase/06-payments` pushed; PR opened against `main`.

Deferred:

- **Payout status reconciliation via webhook** — the cron dispatches and writes `status='processing'`; the eventual `payout.paid` / `payout.failed` webhook handler that flips the row to its terminal state ships with Phase 9 (reconciliation + back-office). Until then, terminal status comes from the nightly Aeropay payout report import.
- **Manual refund retry from admin UI** — the service supports re-running a failed refund with the same `refund_id`, but no admin endpoint exists yet. Wired up alongside the back-office in Phase 13 (operations console).
- **Per-tenant 1099-K aggregation** — annual tax-form generation is a Phase 15 (reporting) deliverable; the ledger already captures every payout in a form the aggregator can consume.

---

## Phase 5 — Cart & Checkout

_Status: complete (2026-05-18). Branch: `phase/05-cart-checkout`._

What landed:

- **`@dankdash/pricing` package** (`packages/pricing/`) — pure-function `computeOrderTotals` that takes priced cart lines + delivery fee + driver tip + discount and returns the integer-cents breakdown the checkout txn snapshots onto `orders`. Cannabis gross-receipts tax (Minn. Stat. § 295.81, 10%) is applied only to lines whose product type is on the cannabis-taxable allowlist; state sales tax (Minn. Stat. § 297A.62, 6.875%) applies to every line; optional local sales tax is passed in per dispensary. All arithmetic via `decimal.js` with banker's rounding at the cent boundary. Reuses `ProductType` from `@dankdash/compliance` so the cannabis-taxable set is single-sourced. Constants checked in as decimal strings so future rates that aren't float-exact remain lossless.
- **`@dankdash/utils` package** (`packages/utils/`) — first occupant: `generateShortCode` returns a six-char Crockford base32 string (alphabet omits `I`, `L`, `O`, `U` to remove read-aloud + OCR ambiguity) for `orders.short_code`. `withCollisionRetry(generate, exists, maxAttempts?)` wraps a generator with an async existence probe and throws `ShortCodeCollisionError` on max-attempts exhaustion so the caller's transaction aborts rather than silently creating an order without a code. Pure functions only — anything needing DI/IO lives elsewhere.
- **`@dankdash/db` repository extensions** — `CartsRepository.findByIdForUser` / `findByIdForUserForUpdate` give cart reads + the checkout transaction's serialization-point lock the user-scoped match that lets cross-user probes return 404 (no info leak) instead of 403. `deleteByIdForUser` does the same. `touch` returns the refreshed row so callers project the new `expiresAt` without a round trip; `createOrGetActive` uses `ON CONFLICT DO NOTHING` + re-read so a racing pair of "open cart" calls never surfaces a 500. `DispensaryListingsRepository.findManyByIds` / `findManyByIdsForUpdate` give bulk advisory reads (cart hydration) + bulk row locks (checkout txn) so two carts overlapping on a listing can't both pass the inventory check and both decrement. `ProductsRepository.findManyByIds` bulk-hydrates the compliance `CartLine` fields. `OrdersRepository.shortCodeExistsSince` powers the collision check, narrowed to the live 30-day window so the index hit stays cheap as the orders table grows. `CART_TTL_MS` (4h) re-exported.
- **`CartModule`** (`apps/api/src/modules/cart/`) — exposes `/v1/carts` under the global `JwtAuthGuard`. Routes: `POST /v1/carts` (idempotent create-or-get per `(userId, dispensaryId)`), `GET /v1/carts/:id`, `POST /:id/items`, `PATCH /:id/items/:itemId` (qty=0 routes to removal), `DELETE /:id/items/:itemId`, `DELETE /:id`, and the body-less `POST /:id/validate?deliveryAddressId=...`. Unit price is snapshotted from the listing on add and survives PATCH-of-quantity so a price update mid-cart doesn't silently re-price the customer. The 4h TTL is refreshed in JS on every mutation. Validate hydrates lines into `CartLine[]`, calls `@dankdash/compliance.evaluateCart`, and returns the full `RuleResult[]` + `cartTotals` the iOS preview needs — never mutates state, never persists the evaluation.
- **`CheckoutModule`** (`apps/api/src/modules/checkout/`) — single endpoint `POST /v1/carts/:id/checkout` runs the 17-step atomic transaction described in spec §3.3.2: cart `FOR UPDATE` lock → bulk listing `FOR UPDATE` lock → inventory re-check (throws `InventoryError` 409 with `shortages[]` on shortfall) → compliance `evaluateCart` server-authoritative (throws `ComplianceError` 422 + snapshots the full `ComplianceEvaluation` onto `orders.compliance_check_payload`) → `computeOrderTotals` → short-code generation with collision retry → `INSERT orders` + `INSERT order_items` (with frozen `productSnapshot`) + `INSERT order_events 'order_placed'` + `order_status_history` row → conditional inventory decrement loop → `DELETE` cart (`cart_items` cascades) → payment method resolution → `INSERT payment_transactions` with `provider='aeropay'` and `provider_ref='pi_stub_<shortCode>'` (real Aeropay arrives in Phase 6) → balanced ledger pair via `LedgerEntriesRepository.recordTransaction` (customer-receivable DR / aeropay-clearing CR, `totalCents` both sides). `CartExpiredError` returns 410 with `error.code='CART_EXPIRED'` so iOS shows the right empty state.
- **`@dankdash/pricing` + `@dankdash/utils` wired into the api workspace** with `decimal.js` and `@types/geojson`. `tsconfig.json` adds both packages to the project-references list. `app.module.ts` registers `CartModule` + `CheckoutModule` into the global imports so the routes mount under the existing `/v1` prefix.
- **13 integration tests against the real Postgres+PostGIS testcontainer**, run via the existing single-fork rig. `cart.flow.test.ts` (6 tests) covers POST idempotency per (userId, dispensaryId), cross-user 404 (no info leak), add/patch/remove with unit price snapshot survival, validate happy path inside the MPLS polygon, validate `passed=false` for 900mg edibles (9× Dark Chocolate Bar over the 800mg cap), and DELETE 204 → GET 404. `beforeEach` rewrites seeded dispensary hours to 24/7 via raw SQL so the hours rule is deterministic regardless of when CI runs. `checkout.flow.test.ts` (7 tests) covers the happy path (response shape, money reconciliation against the orders_total_matches CHECK, persisted orders row, inventory decrement by exactly the line quantity, carts/cart_items rows = 0, one order_placed event row, balanced ledger pair with debits=credits=totalCents, payment_transactions stub with the expected provider_ref and `initiated` status), CART_EXPIRED 410 when expires_at is forced into the past via raw SQL, INSUFFICIENT_INVENTORY 409 on a single-cart over-decrement, COMPLIANCE_EVALUATION_FAILED 422 for the 900mg edible cart with no DB writes, a concurrent same-listing checkout race (Alice and Derek both try to claim the last 2 units — Promise.all asserts exactly one 201 and one 409 with final inventory = 1 and exactly one orders row written — the FOR UPDATE pair on cart + listings is what makes this work), and cross-user 404 on the checkout path itself. Total apps/api suite: 792 tests across 56 files.

Definition-of-Done verification:

- All Phase 5 routes implemented behind `JwtAuthGuard`. The full lifecycle from `POST /v1/carts` to `POST /v1/carts/:id/checkout` is wired and round-trip integration-tested.
- Compliance preview (`POST /:id/validate`) works idempotently with no DB writes and returns the same `ComplianceEvaluation` shape the iOS client mirrors.
- Checkout creates `orders`/`order_items`/`order_events`/`order_status_history`, decrements inventory, deletes the cart, writes the ledger pair, and stubs the payment intent — all in one `db.transaction`. Any failure rolls the whole thing back (verified by the inventory + compliance failure tests asserting zero DB writes downstream).
- Concurrency holds: the `FOR UPDATE` pair on cart row + listings batch serializes overlapping checkouts of the same listing. The integration test exercises this with `Promise.all` against two real principals racing the last 2 units.
- `pnpm typecheck` — 22/22 tasks succeed.
- `pnpm lint` — 15/15 tasks succeed, zero warnings.
- `pnpm test` — 22/22 tasks succeed (792/792 apps/api tests pass; 13/13 of those are the new Phase 5 integration suite).
- `pnpm --filter @dankdash/api build` — produces `dist/main.js`.
- Branch `phase/05-cart-checkout` pushed; PR opened against `phase/04-catalog`.

Deferred:

- **Coverage gate ≥85% on cart and order modules** — both modules have substantial unit + integration coverage, but no `vitest.config.ts` per-module gate is in place yet. Phase 14 (observability + quality gates) introduces the per-module coverage thresholds across the codebase; until then the existing 100% gate on `@dankdash/compliance` and `@dankdash/pricing` (the regulated math) is the binding floor.
- **Real Aeropay payment intent creation** — `payment_transactions.provider_ref` ships as `pi_stub_<shortCode>` with `status='initiated'`. Phase 6 wires the real `@dankdash/aeropay` client (OAuth client credentials, Redis token cache, idempotency keys) and threads it through the checkout transaction.
- **Real-time cart inventory hold (Socket.io broadcast)** — the spec describes a soft hold on listings as items enter active carts. The current implementation skips the soft hold and relies on the checkout-time `FOR UPDATE` + conditional decrement to reject over-sells — correct but with a worse UX (the customer learns at checkout, not on add). Phase 7 (realtime) layers the inventory broadcast on top of the existing add/remove paths.
- **Driver tip cap test at the boundary** — `MAX_DRIVER_TIP_CENTS` is enforced by the Zod schema and unit-covered; no integration test pins the 422 response. Marginal value low since the schema is shared between the unit DTO test and the runtime — covered by the DTO suite already.
- **GraphQL read surface for carts/orders** — Phase 8 introduces the GraphQL gateway for batched read paths the vendor portal uses; this phase's REST endpoints are the production write surface.

---

## Phase 4 — Dispensaries & Catalog

_Status: complete (2026-05-18). Branch: `phase/04-catalog`._

What landed:

- **Four feature modules under `apps/api/src/modules/`** — `dispensaries/`, `catalog/` (products + categories + lab results), `listings/` (vendor-scoped pricing/inventory with RLS-tagged transactions), `search/` (catalog search + facets). Each module owns its controllers, services, DTOs, and unit tests; cross-module reads go through repository interfaces, never raw joins.
- **Public read surface** (`GET /v1/categories`, `/v1/products/:id`, `/v1/dispensaries?lat=&lng=`, `/v1/dispensaries/:id`, `/v1/dispensaries/:id/menu`, `/v1/products/search`). Geo-narrowing uses `ProductsRepository.searchWithFilters` and `DispensariesRepository.listDeliveringTo` — the latter is a `ST_Contains(delivery_polygon, ST_MakePoint(lng, lat)::geography)` against the GIST index, so a half-spec (`?lat` without `?lng`) is rejected at the Zod schema layer with 422. Search returns a paginated `{ results, facets: { categories, strainTypes }, page }` envelope; the facet counts reflect the same filter set as the rows so the iOS pill UI matches the result list. Public routes are `@Public()` — JwtAuthGuard skips them; the per-IP `RateLimitGuard` does not.
- **Admin write surface** (`POST/PATCH /v1/admin/dispensaries`, `POST /v1/admin/dispensaries/:id/{activate,suspend}`, `POST/PATCH /v1/admin/products`, `POST /v1/admin/products/:id/lab-results`, `POST /v1/admin/categories`). Gated by `RolesGuard` to `admin`/`superadmin`. `POST /v1/admin/dispensaries/:id/activate` runs the compliance gate server-side: license not yet expired AND at least one accepted `owner` staff member. Either gate returns 422 `VALIDATION_FAILED` with a specific message; the DB-side `status='active'` UPDATE only runs after both pass.
- **Vendor write surface** (`GET/POST/PATCH/DELETE /v1/vendor/listings`) — protected by a three-guard chain: `JwtAuthGuard` → `RateLimitGuard` (user tracker) → `VendorContextGuard`. The vendor guard requires `X-Dispensary-Id` (422 if missing or non-UUID) and verifies the principal is a member of `dispensary_staff` with `deactivated_at IS NULL` (403 otherwise). `RolesGuard` then narrows to staff roles. Every mutation runs inside a `db.transaction` that calls `select set_config('app.current_dispensary_id', ?, true)` — a no-op under the current single-role pool but already correct for the future `app_vendor` role swap. A cross-vendor PATCH or DELETE matches zero rows and surfaces as 404 (never 200 with leaked content); the repository's `softDeleteForDispensary` only matches `is_active = true` so a double-DELETE returns 404 on the second call.
- **`packages/dispensaries` hours engine** (`isOpenAt`, `nextOpenAt`) extracted to its own package (Phase 4.5) so the compliance engine and the API both consume the same cross-midnight + DST-aware window math. Hours type pins weekday keys to the closed union `'mon'|'tue'|...|'sun'` — seed and DTO schema both match the type now, so `projectDispensary`'s `isOpenAt` call never throws on missing weekday lookup.
- **`packages/storage` R2 presign adapter** (Phase 4.6) — `presignUpload(key, contentType, sizeLimit)` returns a presigned POST + R2 `Cache-Control` headers; `getPublicUrl(key)` builds the CDN URL. Admin/vendor image uploads never proxy bytes through the API.
- **`apps/api/src/modules/catalog-cache`** (Phase 4.7) — `CatalogCacheService` wraps a `CatalogCacheStore` interface backed by Redis in production (`RedisCatalogCacheStore`, 60s TTL, versioned key prefix `v1:`) and by an in-memory map under `NODE_ENV=test` (`MemoryCatalogCacheStore`, also exposed via `@Global()` `CatalogCacheModule`). Public dispensary feed + per-dispensary menu are read-through-cached; vendor listing writes call `cache.invalidateListing(dispensaryId)` after the tx commits so a rolled-back write leaves the cache untouched.
- **Integration test rig** (`apps/api/test/integration/`) — vitest `globalSetup` boots ONE Postgres+PostGIS testcontainer per `pnpm test` invocation via `@dankdash/db/testing.setupTestDb()` and exports `DATABASE_URL`/`TEST_DATABASE_URL` to forked workers. `test/integration/setup.ts` exposes `SEED_IDS` (the stable UUIDv5s the canonical seed produces), `seedFixtures()` (truncate + reseed), and `signTokenFor(app, {userId, role, sessionId?})` which goes through the running app's `JwtService` so RS256 tokens match what `JwtAuthGuard` verifies. The rig also wires `unplugin-swc` into the vitest pipeline — esbuild strips decorators but does NOT emit `design:paramtypes`, so without SWC's `decoratorMetadata: true` NestJS DI silently fails to inject any constructor parameter. With SWC, `app.inject()` exercises the production guard/pipe/filter chain end-to-end.
- **37 integration tests across five files** — `catalog.public.test.ts` (8: categories ordering, product 200/404, ParseUUIDPipe 400, dispensary 200/404, menu 200/404), `dispensaries.geo.test.ts` (7: inside MPLS/STP/MG polygons, outside in LA, half-spec 422, out-of-range 422, unfiltered response shape), `search.ranking.test.ts` (7: `q="northern lights"` returns both NL hits, `q="durban"` excludes NL, category narrowing + facets, dispensary narrowing (skipped-types absent + total strictly smaller than global), unknown dispensary returns empty without leaking existence, paged limit/offset non-overlapping, oversized limit 422), `admin-dispensaries.activate.test.ts` (5: no accepted-owner → 422 owner, expired license → 422 expired, license window end ≤ start → 422 from schema refine, non-admin role → 403, missing auth → 401), `vendor-listings.rls.test.ts` (10: missing/malformed X-Dispensary-Id → 422, non-staff principal → 403, customer role → 403, owner sees only own listings, cross-vendor PATCH/DELETE → 404, double-DELETE → 204 then 404, malformed POST → 422, duplicate SKU → 409). 626 tests pass across the apps/api package overall.

Definition-of-Done verification:

- All Phase 4 endpoints implemented with auth/RLS enforced (deny-by-default global `JwtAuthGuard` + per-route `RolesGuard` + per-vendor `VendorContextGuard`).
- PostGIS geo-queries working: `GET /v1/dispensaries?lat=44.987&lng=-93.273` returns only the MPLS dispensary; outside-polygon points return an empty list; interstate points (LA) return empty.
- Search returns ranked + faceted results via the `tsvector` GIN index (`ts_rank` ORDER BY); facets count the narrowed set, not the global catalog.
- R2 presign adapter (`@dankdash/storage`) wired and unit-covered; LocalStack endpoint resolution works via the `STORAGE_S3_ENDPOINT` env override.
- Redis cache layer functional with explicit invalidation on listing writes; `NODE_ENV=test` swaps the binding for `MemoryCatalogCacheStore` so the suite never touches Redis.
- `pnpm typecheck` — 18/18 tasks succeed.
- `pnpm lint` — 13/13 tasks succeed, zero warnings.
- `pnpm test` — 18/18 tasks succeed (626/626 apps/api tests pass; 37/37 of those are the new Phase 4 integration suite).
- `pnpm --filter @dankdash/api build` — produces `dist/main.js`.
- Branch `phase/04-catalog` pushed; PR opened against `main`.

Deferred:

- **`POST /v1/admin/dispensaries/:id/suspend` end-to-end test** — the route handler ships with unit coverage of `DispensariesService.suspend`, but no integration test pins the 403/422 paths against a real DB. Activation has full coverage; suspend follows the same RolesGuard + repo-update pattern, so the marginal value is low. Pick up alongside Phase 11 (Compliance + Audit ops) when the audit-log surface around dispensary status transitions also lands.
- **`POST /v1/admin/products/:id/lab-results` integration test** — admin lab-result append is unit-covered (`AdminProductsService.appendLabResult`), but the full HTTP round-trip is not exercised. Phase 11 owns the COA ingestion workflow; this gap closes there alongside the COA file-upload + R2 link test.
- **Cache key hit/miss assertions** — the cache wrapper is unit-covered for `MemoryCatalogCacheStore` (hits, misses, TTL expiry, invalidation) but the integration suite does not measure DB call count under a hot vs. cold cache. Phase 14 (observability) adds a cache-hit metric the integration test can read directly; until then the unit tests + production Redis metrics suffice.
- **Real RLS enforcement at the Postgres layer** — current deployment pools as a single app role; the `WHERE dispensary_id = ?` filter in each repo method is the primary guard, the `app.current_dispensary_id` GUC is set per request but the policies are a no-op. Phase 12 (deploy hardening) is where the pool splits into `app_admin`/`app_vendor` and the policies become load-bearing.
- **Catalog cache stampede protection** — multiple cold readers can stampede the loader on key expiry. Production traffic + 60s TTL makes the worst-case cost small enough to defer. Phase 14 adds the singleflight wrapper alongside the dedup-by-key metric so the trade-off is measurable before introducing the code.

---

## Phase 3 — Compliance Engine

_Status: complete (2026-05-18). Commit range: `35e30ac..acb1a6a` (12 commits)._

What landed:

- **`@dankdash/compliance` package scaffold** — pure-function module, no NestJS / no Drizzle / no HTTP. Inputs: an `EvaluationContext` (user, dispensary, delivery location, cart, optional `now`). Output: a `ComplianceEvaluation` snapshot suitable for `orders.compliance_check_payload`. Same engine runs in three places: server checkout transaction (authoritative), API preview endpoint (UX hint), iOS `ComplianceClient` (offline preview).
- **MN statutory constants** (`src/constants.ts`) — one source of truth, every value carries a Minn. Stat. § 342 citation. `MN_PER_TRANSACTION_LIMITS` (56.7 g flower / 8 g concentrate / 800 mg edible THC) are `Decimal` instances built from strings so cap equality holds exactly. `MN_SALES_HOURS.latestClose` is encoded as `26:00` to denote next-day close without wrapping the hour field. Beverage caps (`≤10 mg/serving`, `≤2 servings/container`), `MN_MINIMUM_AGE_YEARS = 21`, `MN_DEFAULT_TIMEZONE = 'America/Chicago'`, and `COMPLIANCE_EVALUATION_VERSION` (date-stamped) round out the public constants.
- **Domain types** (`src/types.ts`) — framework-free. `CartLine.weightGramsPerUnit` and `thcMgPerUnit` are `Decimal` (never `number`). `Weekday` is a closed union so `Record<Weekday, DayHours|null>` is exhaustive without an index signature. `RuleId` includes an `'evaluation'` sentinel reserved for the fail-closed path (no individual rule may emit it). `ComplianceEvaluation` exposes plain `number` totals/limits because the persisted JSONB snapshot is read-only audit data, never re-aggregated downstream.
- **Cart aggregation** (`src/cart-math.ts`) — `PRODUCT_CAP` maps every `ProductType` to one of four buckets (`flower`/`concentrate`/`edibleThc`/`exempt`); pre-rolls and infused pre-rolls roll into flower, vape carts into concentrate, beverages and tinctures into edible THC. `computeCartTotals` accumulates with `Decimal.plus()` and rounds to 3 dp (the MN OCM reporting precision). `totalsToSnapshot` converts to plain numbers at the persistence boundary.
- **Point-in-polygon geofence fallback** (`src/geo.ts`) — standard ray-cast crossing-number, with explicit boundary semantics (west/south edges inside, north/east edges outside) and hole subtraction (inner GeoJSON rings exclude inside points). Production callers run `ST_Contains` at the repo layer; this exists for the iOS preview path and engine unit tests where Postgres is not available.
- **Identity rules** — `checkAge` distinguishes `dob_missing`, `future_dob`, and under-21 (year diff via luxon). `checkKyc` is a single null check on `kycVerifiedAt`. `checkLicense` is a half-open boundary: a license expiring exactly at `now` fails.
- **Sale-hours rule** (`src/rules/check-hours.ts`) — the most subtle file in the engine. Builds BOTH today's and yesterday's effective windows so a query at 01:30 AM resolves against the previous day's `09:00–02:00` window. `anchorAt` uses `dayStart.set({hour, minute})` for hour<24 (wall-clock anchored, DST-aware) and `dayStart.plus({days:1}).set(...)` for hour≥24 — `.set({hour:26})` would normalize and lose the day. State cap intersected with declared hours; dispensary windows narrow but never widen. Spring-forward and fall-back Sundays in America/Chicago are pinned in the test suite.
- **Geofence + per-transaction-limit + provenance rules** — `checkGeofence` delegates to `pointInPolygon`. `checkPerTransactionLimits` compares Decimal totals against Decimal limits (`>` would mis-fire on 56.701 with float64) and reports every violation in a single pass. `checkProductProvenance` walks beverage lines, distinguishing "value present and over cap" from "value missing" (the spec reference impl's `?? 0` would silently let a null beverage pass; this one fails closed).
- **`evaluateCart` composer** — resolves `now = ctx.now ?? new Date()` once at top, runs every rule in fixed order, aggregates the cart for the snapshot, and on any thrown exception captures it as an `evaluation` sentinel rule with `passed: false`. Rule order is identity → license → time → place → cart contents for snapshot readability; outcome is independent of order.
- **Test suite: 133 tests across 12 files** — per-rule unit tests cover every case from spec §3.5 (07:59/08:00/01:59/02:00 hours edges, 56.7g exact / 56.701g over, 8g/8.001g, 800mg/801mg, beverage `10mg/2 servings` cap edges, all four neighbouring-state geofence fails, half-open license boundary, DST transitions both directions); direct unit tests on `cart-math` and `geo`; composite tests on `evaluateCart` (happy path, single-rule fail with others still evaluated, multi-fail, empty cart, fail-closed exception, snapshot JSON-roundtrip, version stamping, 1000-iteration determinism); property tests via fast-check (per-transaction-limit ↔ cap-arithmetic equivalence over 500 random carts, order invariance, partition associativity, exempt-product neutrality, interstate-always-fails, JSON determinism); 50-line performance gate that asserts p99 < 5 ms.
- **100% line / branch / function / statement coverage** on the compliance package — the four genuinely unreachable branches that TypeScript's `noUncheckedIndexedAccess` and strict-narrowing force us to write are marked with `/* c8 ignore */` comments explaining why. Vitest gate (`thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }`) blocks any future regression.

Definition-of-Done verification:

- `pnpm typecheck` — 15/15 tasks succeed.
- `pnpm lint` — 11/11 tasks succeed, zero warnings.
- `pnpm test` — 15/15 tasks succeed (133/133 compliance tests pass; 234/234 api tests pass; 43/43 db tests pass).
- `pnpm --filter @dankdash/compliance build` — produces `dist/index.js` + `dist/index.d.ts` plus per-module entry points.
- Coverage: 100% across all metrics on the compliance package, gated in `vitest.config.ts`.
- 50-line `evaluateCart` perf: p50=0.18 ms, p95=0.29 ms, p99=1.14 ms (budget 5 ms p99) on the local dev machine.
- Branch `phase/03-compliance` pushed; PR opened against `phase/02-auth`.

Deferred:

- **Integration tests through the checkout endpoint** — Phase 4 (Dispensaries + Catalog) and Phase 5 (Cart + Checkout) wire the engine into HTTP routes against a real Postgres; until then, the engine is unit-covered in isolation.
- **Metrc reconciliation gate** — Phase 11 (Compliance + Audit ops) layers the nightly reconciliation worker on top of this engine; the per-order Metrc tag emission lives there, not here.
- **iOS `ComplianceClient` parity** — Phase 12 (iOS rewrite) consumes the generated TS types from `@dankdash/types` to build a Swift mirror; the contract is locked but the Swift port has not been written.
- **Compliance preview endpoint** — Phase 5 exposes `POST /v1/cart/preview-compliance` for the iOS client; the route handler is one line (call `evaluateCart` + serialize) and belongs with the cart routes, not the engine package.

---

## Phase 2 — Auth & Identity

_Status: complete (2026-05-18). Commit range: `bdb2a95..684208f` (33 commits)._

What landed:

- **NestJS bootstrap on Fastify** — `apps/api` scaffolded with `@nestjs/platform-fastify` + `rawBody: true` (Persona HMAC verification requires the exact request bytes). Bootstrap chain wires `@fastify/helmet`, request-id propagation, structured pino logging, the global `ZodValidationPipe`, `LoggingInterceptor`, and `GlobalExceptionFilter` that renders the `openapi-excerpt.yaml` envelope. Smoke suite at `test/bootstrap.test.ts` instantiates the app once per file via a shared factory and pins the `/healthz` + `/readyz` shape.
- **Password service** — argon2id over an HMAC-SHA512 pre-hash with a `PASSWORD_PEPPER` secret. The HMAC step makes a database-only compromise insufficient for offline cracking (the pepper lives in Railway secrets, not the DB). Rotates the pepper via `verify-and-rehash` on the next successful login; runbook lives at `docs/runbooks/password-pepper-rotation.md`.
- **JWT issuance** — RS256 with explicit algorithm-confusion defence (`alg: 'RS256'` is asserted before `jwt.verify` and after, so a forged `alg: 'none'` token never reaches signature validation). Key rotation via a `kid` header that maps to `JWKS` entries; `verifyAccessToken` rejects unknown kids before parsing claims. Access tokens carry `{ sub, sid, role, iss, aud, iat, exp, kid }` only — no PII.
- **Refresh-token family rotation** — `RefreshTokenService.rotate` is OWASP-style: each rotation issues a successor in the same family, the parent row is marked `rotated_at`, and a presented-but-already-rotated token cascades `family_revoked_at` across the whole family (anomaly detection). Storage uses sha256-hashed tokens — plaintext never lands in Postgres. Schema delta `b08b7cf` adds `session_family_id`, `parent_session_id`, `rotated_at`, `family_revoked_at` columns + the reuse-detection migration; repo extension at `f816a96` adds `rotate` + `revokeFamily`.
- **MFA TOTP** — speakeasy-backed `MfaService` with 30-second windows ±1 step. Secrets are AES-256-GCM-encrypted at the column layer (envelope-wrapped DEK under `COLUMN_ENC_MASTER_KEY`) so DB-only access never yields plaintext secrets. `disableMfa` requires a current code so a stolen access token alone cannot strip the second factor.
- **Persona KYC** — `PersonaService.createInquiry` posts to `withpersona.com/api/v1/inquiries`; `handleWebhook` verifies the `Persona-Signature` header (`t=…,v1=…`) with HMAC-SHA256 + a ±300s replay window + constant-time comparison, parses the JSON:API envelope through Zod, and dispatches `inquiry.completed`/`failed`/`expired` to discriminated-union outcomes. Age gate (MN Stat. § 342.46 minimum 21) is enforced at the completion outcome — under-21 raises `KYC_AGE_UNDER_MINIMUM` rather than silently completing.
- **Identity service** — `IdentityService.getMe`/`updateMe`/`startKyc`/`applyKycOutcome` orchestrate the user-facing flows. `applyKycOutcome` is the only place that flips `users.status=active` + stamps `kyc_verified_at` + persists the Persona-verified DOB over the client-typed value.
- **Auth + Identity controllers (9 endpoints)** — `/v1/auth/{register,login,refresh,logout,mfa/setup,mfa/confirm,mfa/verify,mfa/disable}` + `/v1/me` (GET + PATCH) + `/v1/identity/kyc/start` + `/v1/identity/kyc/webhook`. Public/protected boundary enforced by a global `JwtAuthGuard` (deny-by-default) with `@Public` as the opt-out, and `RolesGuard` (allow-list) for role-restricted routes — surfacing `@Public + @Roles` controller mistakes as 403 rather than silently letting them through.
- **Zod DTOs (`nestjs-zod`)** — single `.strict()` schema per endpoint serves the request DTO, response type, and (future) OpenAPI generation. Login uses a discriminated-union response (`status: 'authenticated' | 'mfa_required'`) so the two-step MFA flow is type-safe end-to-end. The KYC webhook DTO is documentation-only; the controller uses `@RawBody()` because re-serializing a Zod-parsed object would invalidate the HMAC.
- **Column encryption** — `EncryptionService` provides AES-256-GCM envelope encryption with a 32-byte DEK per encryption call wrapped by `COLUMN_ENC_MASTER_KEY` (loaded from Railway secrets); ciphertext layout is `version(1) | wrapped_dek(60) | iv(12) | tag(16) | payload(N)` so future master-key rotation is a wrap-only re-encryption pass. Used by MfaService for `mfa_secret_enc`.
- **Rate limiting** — `RateLimitGuard` keyed on a sha256-truncated tracker (`ip`, `user`, `email-from-body`, `refresh-from-body`) backed by Redis `INCR + PEXPIRE NX + PTTL` pipeline (fixed window, one round trip). Multi-tracker `@RateLimit` decorator: `/auth/login` is `5/min per-IP AND 10/hour per-email` simultaneously. `MemoryRateLimitStore` provides a Redis-free fallback for `NODE_ENV=test`. RateLimitError details carry `retryAfterSeconds` for client back-off.
- **234 unit tests, 16 files** — covers password (20), jwt (9), refresh-token (22), mfa (20), persona (32), encryption helper, auth.service (17), identity.service (15), auth.controller (9), identity.controller (7), jwt-auth.guard (7), roles.guard (6), rate-limit.guard (12), zod-validation.pipe (5), DTO schemas (auth 34 + identity 13), bootstrap smoke (6). All instantiate components directly with hand-rolled fakes — Nest container is only spun in the bootstrap smoke suite.
- **Eight new error classes in `@dankdash/types`** — `PasswordError`, `EncryptionError`, `ConfigError`, `KycError`, plus expansions to `AuthError` (`UNAUTHENTICATED`, `MFA_CODE_INVALID`). Every controller-reachable failure now has a stable code; the global filter maps these to HTTP statuses without leaking internals.

Definition-of-Done verification:

- `pnpm typecheck` — 15/15 tasks succeed.
- `pnpm lint` — 11/11 tasks succeed, zero warnings.
- `pnpm test` — 15/15 tasks succeed (234/234 api tests pass).
- `pnpm --filter @dankdash/api build` — produces `dist/main.js` and module entry points.
- API coverage: **97.25% stmts / 91.51% branch / 80.59% funcs / 97.25% lines** against the 80/70/80/80 thresholds in `apps/api/vitest.config.ts`.
- Branch `phase/02-auth` pushed; PR opened against `phase/01-database`.

Deferred:

- **Integration suite (`test/integration/auth.routes.test.ts`)** — guards/pipes/filters are unit-covered but not end-to-end exercised against a real HTTP server + Postgres. Wait for Phase 3 (compliance) to land so the integration suite can use the same `seedScenario('default')` fixture both phases share.
- **JWKS rotation runbook** — current `JwtService` accepts a `kid → key` map at construction; ops procedure for rotating without dropping in-flight tokens (publish new kid, hold for 1× access TTL, retire old kid) belongs in `docs/runbooks/` once Phase 12 ships the secrets-rotation harness.
- **Persona inquiry resumption** — re-starting `/kyc/start` mints a new inquiry rather than resuming an open one. Persona supports `resume-inquiry-id`, but the iOS flow doesn't yet detect the resumable case; revisit alongside Phase 13's checkout-web KYC hand-off.
- **Refresh-token reuse-detection metrics** — `RefreshTokenService.rotate` revokes the family on reuse but doesn't emit a metric; Phase 14 observability adds the Prometheus counter so security can alert on rising reuse-detection rates without DB query.

---

## Phase 1 — Database & Migrations

_Status: complete (2026-05-18). Commit range: `ffc09d7..91b08da` (12 commits)._

What landed:

- Drizzle schema split per domain — `packages/db/src/schema/{identity,dispensaries,catalog,carts,orders,payments,dispatch,compliance,notifications,audit}.ts` plus a shared `enums.ts` and a `geo.ts` with custom PG types for `geography(Point|Polygon, 4326)`, `citext`, and `bytea`. Round-tripping into JSON `GeoPoint`/`GeoPolygon` happens at the repository boundary so consumers never see raw EWKT.
- Hand-tuned init migration (`src/migrations/0000_init.sql` + `.down.sql`) — PostGIS extensions, append-only triggers on `order_events` / `ledger_entries` / `audit_log`, products full-text `search_vector` with weight A/B/C/D, beverage potency + serving-count CHECK constraints derived from Minn. Stat. § 342.27, monthly partitions on `order_events` / `notifications` / `audit_log` (14-month bootstrap), weekly partitions on `driver_location_history` (26-week bootstrap), RLS policies for the `app_vendor` role keyed on `app.current_dispensary_id`, refunds separation-of-duties CHECK.
- Custom migration runner (`src/migrate.ts`) with `pg_advisory_xact_lock` serialization, file-hash drift detection (refuses to apply when a previously-recorded migration's content has changed), up/down/status modes. CLI wrapper at `src/migrate.cli.ts` exposes `pnpm --filter @dankdash/db migrate{,:rollback,:status}`.
- Pool client (`src/client.ts`) — `createPool` and `createPoolFromEnv` wire Drizzle on top of postgres-js with `prepare: false` (so transaction-rollback test isolation works), structured pino slow-query logging (configurable threshold, default 250ms), and a typed `timed()` helper for ad-hoc instrumentation.
- Repository layer (`src/repositories/*.repo.ts`) — one class per domain with strict typed I/O, geofence queries via `ST_Contains`, race-safe inventory decrement (`UPDATE ... WHERE quantity_available >= ?`), refunds separation-of-duties enforced in the repo before the CHECK fires, balanced double-entry ledger that rejects unbalanced inputs before touching the DB, cart upsert idempotency, push token rotation. All repos accept a Drizzle handle so they compose inside transactions.
- Deterministic seed (`src/seed.ts`) — `stableUuid(category, key)` derives UUIDv5 IDs from a per-app namespace so the same fixture produces the same primary keys on every run. Seeds 5 users (4 customers + 1 admin), 3 dispensaries with real PostGIS geometry (North Loop Cannabis MPLS, Capitol Cannabis STP, The Grove Moorhead), 8 product categories, ~20 products spanning every `product_type` the catalog admits, varied dispensary listings (MPLS deepest catalog), seeded payment methods + dispensary staff.
- Testcontainers harness moved into `@dankdash/db/testing` — co-located with the schema and migration runner so any package can `import { setupTestDb } from '@dankdash/db/testing'`. Lives in db (not test-utils) because the test-utils → db → test-utils edge was a build-graph cycle for turbo; one-way deps only now.
- `@dankdash/test-utils` extended with `seedScenario(db, 'default'|'minimal'|'empty')`, `withTransaction(pool, cb)` for per-test isolation without paying the truncate cost, and `freezeTime`/`advanceTime`/`unfreezeTime` wrapping vitest fake timers with the `MN_TIMEZONE = 'America/Chicago'` constant.
- `RepositoryError` added to `@dankdash/types` — raised when the repo layer detects an "INSERT...RETURNING returned zero rows" or "row I just wrote vanished" infrastructure invariant violation. Stable code `REPOSITORY_INVARIANT_VIOLATION` so ops can alert on it distinctly from generic 500s.
- Integration suite (`packages/db/test/integration/{invariants,seed-and-repos,repositories}.test.ts`) — 43 tests against a shared testcontainer covering schema invariants (updated_at trigger, search_vector populating, beverage CHECK constraints, append-only enforcement), seed determinism, and ~80 repository methods across every domain. Coverage 79% lines / 70% branches / 75% functions against the 75/60/75 thresholds in `vitest.config.ts`.
- ESLint test override extended to allow `@typescript-eslint/no-non-null-assertion` in `test/**/*.ts` (the `row!` assertion is the test itself), and project-wide `restrict-template-expressions` set to `allowNumber: true` so `${count}` in test names doesn't trigger the rule.

Definition-of-Done verification:

- `pnpm typecheck` — 15/15 tasks succeed.
- `pnpm lint` — 11/11 tasks succeed, zero warnings.
- `pnpm test` — 15/15 tasks succeed (43/43 db integration tests pass).
- `pnpm --filter @dankdash/db build` — produces `dist/index.js`, `dist/testing/`, and copies `dist/migrations/` for runtime consumers.
- Coverage thresholds (`lines: 75 / statements: 75 / functions: 75 / branches: 60`) met across the db package.
- Branch `phase/01-database` pushed; PR opened against `main`.

Deferred:

- Order-creation lifecycle integration tests (lines 26%-covered in `orders.repo.ts`) — wait until Phase 3 lands the compliance engine and Phase 4 lands the cart→checkout flow, so the order lifecycle can be tested end-to-end through the real entry points instead of with hand-rolled SQL inserts.
- RLS policy tests (assert `app_vendor` cannot read another dispensary's listings) — Phase 2 introduces the role-assumption helper that makes these tests natural to write.
- Column-level encryption (envelope-wrapped via `pgcrypto` for restricted columns like DOB, ID document number) — Phase 2 (Auth & Identity) owns the key management and decryption boundary, so the encryption columns are present in the schema but no app code yet writes ciphertext.

---

## Phase 0 — Foundation & Tooling

_Status: complete (2026-05-17). Commit range: `eccf1eb..2d97d31` (12 commits). PR: [#1](https://github.com/jwillz7667/DankDash/pull/1)._

What landed:

- Turborepo + pnpm workspace at the repo root, with `apps/{api,realtime,workers,portal,checkout-web}` and `packages/{db,compliance,types,config,ui,test-utils}` placeholders so subsequent phases can drop in real code.
- Strict TypeScript base (`packages/config/tsconfig.base.json`) — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, NodeNext modules, composite project references.
- Shared ESLint flat config (`packages/config/eslint.config.js`) on typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, with a custom restricted-syntax rule that bans `throw new Error(...)` in favor of `DomainError` subclasses.
- Prettier (100 col, single quote, trailing-comma `all`), `.editorconfig`, `.prettierignore`.
- `docker-compose.yml` with Postgres 16+PostGIS (5433), Redis 7 (6380), Mailhog (1026/8026), LocalStack S3 (4566), healthchecks, init SQL that enables `postgis`, `pg_trgm`, `pgcrypto`, `citext`, `uuid-ossp`, `btree_gin`, `pg_stat_statements` and bootstraps a `dankdash_test` database.
- `.env.example` mirrors the Zod `EnvSchema` in `packages/config/src/env.ts` (database, redis, JWT, password pepper, column-encryption key, R2/S3, Aeropay, Persona, Veriff, Metrc, Mapbox, Twilio, Resend, APNS, Sentry, OTEL, feature flags). `loadEnv()` fails fast with a typed `EnvValidationError` that lists every offending key.
- Pino logger factory (`packages/config/src/logger.ts`) with the PII redaction path list called out in the spec — `password`, `mfa_secret`, `*.date_of_birth`, `*.scan_image_key`, headers.authorization, etc.
- `DomainError` hierarchy in `packages/types/src/errors.ts` — `ValidationError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ComplianceError`, `InventoryError`, `PaymentError`, `ExternalServiceError`, `RateLimitError` — plus `toErrorEnvelope` matching `docs/spec/openapi-excerpt.yaml`. Tests cover status-code ranges, error codes, and cause preservation.
- Git hooks via `.githooks/` (not `husky` — the runtime sandbox forbids writing into `.husky/`). `prepare` runs `scripts/install-git-hooks.sh`, which sets `core.hooksPath=.githooks`. Pre-commit runs `lint-staged`; commit-msg runs `commitlint` against the conventional config in `commitlint.config.js` with the project's scope allowlist.
- CI workflow (`.github/workflows/ci.yml`) — typecheck/lint/test/build with a Postgres+PostGIS service and Redis service, Turbo cache, Codecov upload, separate "compliance suite" job that blocks merges into `main` if the compliance package fails. Staging and production deploy workflows wire Railway CLI calls per service with manual approval for prod.
- Project root files — `README.md` (getting started, layout, stack), `LICENSE` (proprietary), `.gitignore` (Node + Xcode + Docker + secrets), `.nvmrc` (20), this `PROGRESS.md`.
- ADRs in `docs/adr/`: `0001-modular-monolith.md`, `0002-drizzle-orm.md`, `0003-monorepo-turborepo.md`.

Definition-of-Done verification:

- `pnpm install` — clean install verified.
- `docker compose config` — stack definition validates; full `up` smoke-tested earlier in the phase.
- `pnpm typecheck` — 15/15 tasks succeed.
- `pnpm lint` — 11/11 tasks succeed, zero warnings.
- `pnpm test` — 15/15 tasks succeed.
- Pre-commit + commit-msg hooks fire on real commits (three commits during this phase were rejected by commitlint for >72 char headers and had to be shortened).
- Branch `phase/00-foundation` pushed; PR #1 opened against `main`. CI verification continues on the PR.

Deferred:

- Husky-specific instrumentation (replaced by `.githooks/`).
- iOS app rewrite — the existing `DankDash/Item.swift` + `ContentView.swift` are still the SwiftUI template. Replacement begins in Phase 12.
