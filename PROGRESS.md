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

## Phase 0 — Foundation & Tooling

_Status: in progress (2026-05-17). Commit range: pending._

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

- `pnpm install` — verified during phase wrap-up.
- `docker compose up` — verified during phase wrap-up.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` — verified during phase wrap-up.
- CI green on the Phase 0 PR — verified once the PR is opened.

Deferred:

- Husky-specific instrumentation (replaced by `.githooks/`).
- iOS app rewrite — the existing `DankDash/Item.swift` + `ContentView.swift` are still the SwiftUI template. Replacement begins in Phase 12.
