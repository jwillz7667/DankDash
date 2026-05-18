# DankDash

Three-sided cannabis delivery marketplace for the Minnesota adult-use market.

- **Consumer iOS** — `DankDash/` (SwiftUI, SwiftData, Swift 6 strict concurrency)
- **Driver iOS** — `DankDasher/` (created in Phase 19)
- **Vendor portal** — `apps/portal/` (Next.js 15, deploys to Vercel)
- **Web checkout** — `apps/checkout-web/` (Next.js, App Store guideline 1.4.3 workaround)
- **API + workers + realtime** — `apps/api`, `apps/workers`, `apps/realtime` (NestJS on Fastify, BullMQ, Socket.io — deploys to Railway)
- **Shared packages** — `packages/{db,compliance,types,config,ui,test-utils}`

The build plan is laid out across 23 phases in `docs/CLAUDE-CODE-PHASES.md`. We are currently in **Phase 0 — Foundation & Tooling**.

---

## Source of truth

| Document                               | Purpose                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docs/spec/DankDash-Technical-Spec.md` | Full system spec — three apps, modular monolith, schema, deploy, integrations, threat model |
| `docs/spec/schema.sql`                 | Authoritative Postgres 16 DDL (PostGIS, RLS, partitioning, triggers, CHECK)                 |
| `docs/spec/openapi-excerpt.yaml`       | API contract for compliance-gated paths                                                     |
| `docs/spec/compliance.service.ts`      | Reference compliance engine — MN Stat. § 342.27 limits and `RuleResult` shape               |
| `docs/CLAUDE-CODE-PHASES.md`           | 23-phase build plan + Definition-of-Done per phase                                          |
| `docs/adr/`                            | Architecture Decision Records                                                               |
| `CLAUDE.md`                            | Non-negotiable rules — every Claude Code session reads this first                           |
| `PROGRESS.md`                          | Phase-by-phase changelog updated at the end of each phase                                   |

When the spec and the existing code disagree, the spec wins.

---

## Prerequisites

- **Node** `20.x` (a `.nvmrc` is committed — `nvm use` picks it up)
- **pnpm** `9.x` (`corepack enable && corepack prepare pnpm@9.12.3 --activate`)
- **Docker** with the `docker compose` plugin (Docker Desktop 4.x or OrbStack)
- **Xcode** `16.x` (only required for the iOS apps)
- Optional: `awscli` for poking at LocalStack S3, `psql` for direct DB inspection

---

## First-run setup

```bash
nvm use                         # picks up Node 20 from .nvmrc
corepack enable                 # makes pnpm available

cp .env.example .env            # then fill in real values for any secrets

pnpm install                    # also installs the .githooks pre-commit hook
docker compose up -d            # Postgres+PostGIS, Redis, Mailhog, LocalStack

pnpm typecheck                  # tsc --noEmit across every package
pnpm lint                       # eslint + prettier check
pnpm test                       # vitest across every package
```

Generate dev JWT keys when you need them:

```bash
./scripts/gen-jwt-keys.sh >> .env
```

---

## Common commands

| Task                         | Command                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| Run everything in watch mode | `pnpm dev`                                                        |
| Run a single app in watch    | `pnpm --filter @dankdash/api dev`                                 |
| Run one test file            | `pnpm --filter @dankdash/compliance test -- path/to/file.test.ts` |
| Apply database migrations    | `pnpm --filter @dankdash/db migrate`                              |
| Seed deterministic dev data  | `pnpm --filter @dankdash/db seed`                                 |
| Format the whole repo        | `pnpm format`                                                     |
| Check formatting (CI parity) | `pnpm format:check`                                               |
| Build for production         | `pnpm build`                                                      |
| Bring infra up               | `docker compose up -d`                                            |
| Reset infra (wipes data)     | `docker compose down -v`                                          |
| Open the iOS consumer app    | `open DankDash.xcodeproj`                                         |

Mailhog UI is at `http://localhost:8026`. LocalStack S3 is at `http://localhost:4566`.

---

## Repository layout

```
apps/
  api/              # NestJS on Fastify adapter (Phase 2)
  realtime/         # Socket.io service for live order updates (Phase 9)
  workers/          # BullMQ workers (Phase 6+)
  portal/           # Next.js 15 vendor portal (Phase 13)
  checkout-web/     # Next.js consumer checkout (Phase 18)
packages/
  db/               # Drizzle schema, migrations, repositories (Phase 1)
  compliance/       # Pure compliance functions — 100% covered (Phase 3)
  types/            # Shared types + DomainError hierarchy
  config/           # eslint, prettier, tsconfig base, env loader, pino logger
  ui/               # Shared React components (Phase 13)
  test-utils/       # Testcontainers helpers + seeded scenarios (Phase 1)
DankDash/           # Consumer iOS app (existing Xcode project)
DankDash.xcodeproj/
docs/
  spec/             # System spec, schema.sql, openapi excerpt, compliance ref
  adr/              # Architecture decision records
  CLAUDE-CODE-PHASES.md
  CLAUDE-CODE-PROMPTS.md
infra/
  postgres/         # initdb extension scripts + test DB bootstrap
  localstack/       # S3 bucket seeding
scripts/            # gen-jwt-keys, install-git-hooks, run-phase
.github/workflows/  # CI, deploy-staging, deploy-prod
.githooks/          # pre-commit (lint-staged), commit-msg (commitlint)
```

The two iOS apps live at the repo root rather than inside `apps/` — they are Xcode projects, not pnpm workspaces.

---

## Stack at a glance

| Concern               | Choice                                           | Why                                                                                   |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| HTTP framework        | NestJS on Fastify adapter                        | DI + module boundaries matter for a regulated codebase                                |
| ORM                   | Drizzle                                          | PostGIS-friendly raw SQL, reviewable migration files (`docs/adr/0002-drizzle-orm.md`) |
| Realtime              | Socket.io as a standalone Railway service        | Sticky sessions, isolation from API process                                           |
| Validation            | Zod via `nestjs-zod`                             | Single schema serves DTO, response type, and OpenAPI generation                       |
| Background jobs       | BullMQ on Redis                                  | First-class Node integration, idempotent retries                                      |
| Logging               | pino with PII redaction                          | JSON in prod, pretty in dev, redaction paths in `packages/config/src/logger.ts`       |
| Identity verification | Persona (onboarding) + Veriff (delivery handoff) | Per spec § 7.4                                                                        |
| Payments              | Aeropay ACH                                      | Cannabis-friendly, no card networks                                                   |
| Maps                  | Mapbox                                           | Geocoding + driver routing                                                            |
| iOS                   | SwiftUI + SwiftData, Swift 6 strict concurrency  | Modern, MainActor-isolated by default                                                 |

---

## Compliance — non-negotiable

- MN per-transaction limits live as constants in `packages/compliance/src/constants.ts` with statute citations (Minn. Stat. § 342.27). Never duplicated, never relaxed for tests.
- Sale hours 8:00 AM – 2:00 AM `America/Chicago`. DST transitions are tested.
- Server is authoritative on every compliance check. The client preview is cosmetic.
- Driver ID scan at handoff (Veriff) is mandatory; `delivered` is unreachable without it.
- Metrc reconciliation runs nightly; failures retry up to 24h then escalate.
- A failing test in `packages/compliance` blocks deploys.

Full rules: see `CLAUDE.md` and `docs/spec/DankDash-Technical-Spec.md` § 7.

---

## Git workflow

- One branch per phase (`phase/00-foundation`, `phase/01-database`, …)
- Conventional Commits enforced by `commitlint` on every commit (`feat(api): …`, `fix(compliance): …`)
- Pre-commit hook runs `lint-staged` (eslint --fix + prettier)
- 5–15 commits per phase, each a logical unit
- PR opened at the end of each phase; never self-merge

---

## License

Proprietary — see [`LICENSE`](./LICENSE). All rights reserved.
