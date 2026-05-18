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
