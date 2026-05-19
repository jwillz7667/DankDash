# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo is at bootstrap. Two things coexist:

1. **An Xcode iOS app scaffold** at `DankDash.xcodeproj` / `DankDash/` — created from the SwiftUI + SwiftData template. `ContentView.swift` and `Item.swift` are the default `Item` CRUD example. **None of this is production code.** It is a placeholder for the DankDash consumer iOS app described in the spec.
2. **A complete production specification** in `spec-docs/`. This is the source of truth for everything that is going to be built. Read it before designing or writing anything.

The gap between (1) and (2) is the work. Do not improvise around the spec — when the spec and the existing code disagree, the spec wins, and the existing code is the thing that's wrong.

## Source of truth — read these first

| File                                   | What it is                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `spec-docs/DankDash-Technical-Spec.md` | Full system spec — three apps, backend modules, schema overview, deployment, integrations, threat model, phasing               |
| `spec-docs/schema.sql`                 | Authoritative Postgres 16 DDL (PostGIS, RLS, partitioning, triggers, CHECK constraints)                                        |
| `spec-docs/openapi-excerpt.yaml`       | API contract for compliance-gated paths (cart validate/checkout, etc.)                                                         |
| `spec-docs/compliance.service.ts`      | Reference implementation of the MN cannabis compliance engine — the limits, citations, and `RuleResult` shape are not advisory |
| `spec-docs/CLAUDE-CODE-PHASES.md`      | 23-phase build plan with task lists and Definition-of-Done checklists per phase                                                |
| `spec-docs/CLAUDE-CODE-PROMPTS.md`     | Session orchestration prompts; restates non-negotiables                                                                        |
| `app-outline.md`                       | Original product brief — useful for UX intent, superseded by the spec for technical detail                                     |

When a phase begins, re-read the relevant `CLAUDE-CODE-PHASES.md` section and the corresponding spec section together. Phases are scoped to single sessions and each has a Definition of Done — do not declare a phase done while any checkbox is unmet.

## Target architecture

Three clients against one modular-monolith backend:

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ DankDash (iOS)   │   │ Vendor Portal    │   │ DankDasher (iOS) │
│ SwiftUI consumer │   │ Next.js 15 / Vercel │   │ SwiftUI driver   │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  REST + GraphQL (read) + WSS (Socket.io)             │
         └────────────────┬─────────────────────────────────────┘
                          │
                ┌─────────▼──────────┐    ┌────────────────────┐
                │ apps/api (NestJS)  │◄──►│ apps/realtime      │
                │ Railway            │    │ (Socket.io) Railway │
                └─────────┬──────────┘    └────────┬───────────┘
                          │                        │
                          └─────────┬──────────────┘
                                    │
              ┌─────────────────────┼──────────────────────────┐
              │                     │                          │
        ┌─────▼──────┐    ┌─────────▼────────┐    ┌────────────▼────┐
        │ Postgres 16│    │ Redis (cache,    │    │ Cloudflare R2   │
        │ + PostGIS  │    │ BullMQ, Socket.io│    │ (images, ID     │
        │ Railway    │    │ adapter) Railway │    │ scans, COAs)    │
        └────────────┘    └──────────────────┘    └─────────────────┘
```

Backend is a **modular monolith** (deliberately not microservices — see `DankDash-Technical-Spec.md` §2.2). Module list and ownership are in §2.2. Each module owns its tables; cross-module reads go through repository interfaces, never raw cross-domain joins.

**Deployment split:** Backend (api + realtime + workers + Postgres + Redis) on Railway. Vendor portal on Vercel. iOS apps via TestFlight, with Apple's cannabis-policy workaround for the consumer app (in-app browses, checkout redirects to `app.dankdash.com` — see spec §10.4).

## Planned monorepo layout

Per `CLAUDE-CODE-PHASES.md` Phase 0, the backend/portal/driver-web code will be a Turborepo at this repo root:

```
apps/
  api/                # NestJS (Fastify adapter)
  realtime/           # Socket.io
  workers/            # BullMQ
  portal/             # Next.js 15 vendor portal — deploys to Vercel
  checkout-web/       # Next.js consumer checkout (Apple workaround)
packages/
  db/                 # Drizzle schema, migrations, repositories
  compliance/         # @dankdash/compliance — pure functions, 100% covered
  types/              # generated from OpenAPI
  config/             # shared eslint, tsconfig, prettier, env loader
  ui/                 # shared React components
  test-utils/         # Testcontainers helpers, seeded scenarios
docs/spec/            # the spec docs live here once the monorepo is created
                      # (currently at spec-docs/ — to be moved in Phase 0)
infra/                # Dockerfiles, railway.toml, GH composite actions
DankDash/             # iOS consumer (existing Xcode project, gets rewritten)
DankDasher/           # iOS driver app (to be created)
```

The two iOS apps stay as Xcode projects at the repo root, **not** inside `apps/`. They are versioned in the same git repo but are not pnpm workspaces.

## Stack decisions that override the user's global defaults

The user's global `~/.claude/CLAUDE.md` lists "Fastify + Prisma" as the default TypeScript backend. **This project explicitly chose differently** — follow the project spec, not the global default:

| Concern        | Project decision (per spec)                  | Why                                                                                                             |
| -------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HTTP framework | **NestJS on Fastify adapter**                | DI + module boundaries matter for a regulated codebase; Fastify adapter keeps the perf                          |
| ORM            | **Drizzle** (not Prisma)                     | PostGIS requires raw SQL with Prisma anyway; migration files are reviewable SQL — see ADR `0002-drizzle-orm.md` |
| Realtime       | **Socket.io as a separate Railway service**  | Sticky sessions via Railway TCP proxy; isolation from the API process                                           |
| Validation     | **Zod via `nestjs-zod`**                     | Single schema serves request DTO, response type, and OpenAPI generation                                         |
| Logging        | **pino** with PII redaction paths configured | Required redactions listed in Phase 0.8                                                                         |

If you find yourself reaching for Prisma, Express, or a single-process Socket.io, stop and re-read the spec — there is a reason it isn't there.

## Non-negotiable rules

These come from `CLAUDE-CODE-PHASES.md` and `compliance.service.ts`. They are not style preferences.

**Cannabis compliance** — failure here is an existential threat to the business, not a bug:

- The MN per-transaction limits (`56.7g` flower, `8g` concentrate, `800mg` edible THC) are constants in `packages/compliance/src/constants.ts` with statute citations (Minn. Stat. § 342.27). Never hardcode them anywhere else. Never relax them "for testing" — write fixtures that pass legitimately or test the failure path explicitly.
- Sale hours: 8:00 AM – 2:00 AM local. Dispensaries can narrow this, never widen. Timezone is America/Chicago; DST transitions are tested.
- Server is authoritative on every compliance check. The iOS client duplicates the calculation for UX preview only; the checkout endpoint re-runs it inside the same transaction that creates the order. The full evaluation result is snapshotted onto `orders.compliance_check_payload`.
- Beverages: ≤10 mg THC/serving, ≤2 servings/container. Catalog admission and compliance evaluation both enforce this.
- Geofence: delivery addresses must lie inside the dispensary's `delivery_polygon` (PostGIS `ST_Contains`). Interstate addresses always fail (no MN → WI/IA/SD/ND deliveries — federal).
- Driver ID scan at handoff is mandatory and non-bypassable. The `delivered` state cannot be reached without a successful Veriff session recorded on the order.
- Metrc package tags reconcile nightly. Every delivered order produces a Metrc receipt; failures retry up to 24h then escalate.
- Compliance tests run on every commit; **a failing compliance test blocks deploys**.

**Order lifecycle** — see `DankDash-Technical-Spec.md` §3.3:

- The order state machine is implemented as XState v5 mirroring the DB enum. Server is authoritative; clients request transitions, they don't perform them.
- Every transition writes an immutable `order_events` row and an `order_status_history` row in the same transaction as the status update. Never bypass this — auditors will read it.
- `order_events` is append-only — no UPDATE or DELETE permitted to the app role.

**Money, IDs, and time:**

- Money is `NUMERIC(12,2)` in the DB and `integer` cents in code. Never `FLOAT`. Never JavaScript `number` for cannabis weights — use `decimal.js`.
- Primary keys are UUIDv7 generated in the app layer. `gen_random_uuid()` is the DB fallback only.
- All timestamps are `timestamptz`, stored UTC, rendered with `luxon` against `America/Chicago` for business-hour logic.

**Data classification** — see `DankDash-Technical-Spec.md` §8.1:

- DOB, ID document numbers, scan images, license numbers, bank refs, MFA secrets are **Restricted**. Column-level encryption via `pgcrypto` envelope encryption (column key wrapped by master key in Railway secret manager). Decryption happens in the app layer — DBA read access alone must not yield plaintext.
- Never log ID document numbers, DOB, or scan image content. Log hashes or redacted values. The pino redaction paths in `packages/config/src/logger.ts` are part of the spec — extend them, don't remove them.
- Row-level security is enabled on `orders`, `order_items`, `cart_items`, `dispensary_listings`, `payouts`, `payment_transactions`. The API sets `app.current_dispensary_id` per request via `SET LOCAL`. Do not bypass RLS — it is defense in depth, not the primary guard.

**Code quality** (from `CLAUDE-CODE-PHASES.md` "Non-Negotiable Rules"):

- Zero `any` in TypeScript. `unknown` and narrow, or define the real type.
- Zero `// TODO` placeholders left behind. If you can't implement it, the phase isn't done — write to `BLOCKED.md` with what you need.
- Zero `console.log` in committed code. Use pino on backend, `os_log` on iOS, the structured logger on Next.js.
- Zero silent catches. `catch (e) {}` is forbidden — handle, log with context, or rethrow.
- Errors are typed per-domain: `ComplianceError`, `PaymentError`, `InventoryError`, etc. — extend a `DomainError` base with `code` and `statusCode`. Never `throw new Error(...)`.
- Tests written in the same phase as the code. `packages/compliance/` and `payments` require **100% line coverage**. Other services target 80%.

## Commands

### Currently usable (Xcode project only)

```bash
# List schemes/targets
xcodebuild -list -project DankDash.xcodeproj

# Build the consumer iOS app (default scheme: DankDash)
xcodebuild -project DankDash.xcodeproj -scheme DankDash -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build

# Clean
xcodebuild -project DankDash.xcodeproj -scheme DankDash clean

# Open in Xcode
open DankDash.xcodeproj
```

The Xcode project targets `IPHONEOS_DEPLOYMENT_TARGET = 26.4`, Swift 5.0, with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` and `SWIFT_APPROACHABLE_CONCURRENCY = YES` (Swift 6 strict concurrency on). Bundle ID `Res.DankDash`, dev team `487LC4H9U4`. iCloud + CloudKit + APNs entitlements present but not yet wired.

### After Phase 0 (monorepo scaffolded)

The green-light command set that must pass before any phase is declared complete:

```bash
pnpm install
pnpm typecheck                        # tsc --noEmit across all packages
pnpm lint                             # eslint + prettier check
pnpm test                             # vitest across all packages
pnpm --filter @dankdash/api build     # production build of API
```

Per-package operations:

```bash
pnpm --filter @dankdash/db migrate              # apply Drizzle migrations
pnpm --filter @dankdash/db seed                 # deterministic dev seed
pnpm --filter @dankdash/api dev                 # NestJS in watch mode
pnpm --filter @dankdash/api test -- <pattern>   # single test
pnpm --filter @dankdash/portal dev              # Next.js vendor portal
docker compose up                               # Postgres 16+PostGIS, Redis, Mailhog, LocalStack
```

These commands do **not** work today — they exist once Phase 0 is complete. If you find yourself running one and it fails because the monorepo isn't set up, that's the signal that Phase 0 hasn't been done yet.

## Git workflow

- One branch per phase: `phase/00-foundation`, `phase/01-database`, …
- Conventional commits required (commitlint enforces): `feat(compliance): add per-transaction limit validator`. Scope is the package or module name.
- 5–15 commits per phase, each a logical unit. No "Phase N done" mega-commits.
- PR opened at end of phase; do not self-merge — wait for user review.
- `PROGRESS.md` (created in Phase 0) gets a one-paragraph entry at the end of each phase.

## When stuck

1. Re-read the spec section for what you're building. The answer is usually there.
2. Look at patterns established in earlier phases — do not invent new ones in parallel.
3. If genuinely blocked, write `BLOCKED.md` at the repo root: what you were doing, what you tried, what failed, what decision you need from the user. Do not stub past it.
