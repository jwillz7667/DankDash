# DankDash — Claude Code Development Plan

**Audience:** Claude Code (autonomous coding agent)
**Project root:** `~/dankdash` (Turborepo monorepo)
**Reference docs (read these first, every session):**

- `docs/spec/DankDash-Technical-Spec.md`
- `docs/spec/schema.sql`
- `docs/spec/openapi-excerpt.yaml`
- `docs/spec/compliance.service.ts`
- `CLAUDE.md` (project-level guidance — created in Phase 0)

---

## ⚠️ READ BEFORE EVERY PHASE — NON-NEGOTIABLE RULES

These rules apply to **every** phase. They are not suggestions.

### 1. Code Quality Standards

You are writing code as a **principal engineer at a top-tier company** would write it. That means:

- **No placeholder comments.** Never write `// TODO: implement this` and move on. If you can't implement it now, the phase isn't done.
- **No `any` types in TypeScript.** Ever. If you reach for `any`, you're avoiding a real type. Use `unknown` and narrow, or define the real type.
- **No console.log in committed code.** Use the configured logger (pino on backend, os_log on iOS, structured logger on Next.js).
- **No magic numbers or strings.** Constants go in `constants.ts` files with named exports, statute citations in comments where applicable.
- **No silent catches.** `catch (e) {}` is forbidden. Either handle the error meaningfully, log it with context, or re-throw.
- **No commented-out code.** Delete it. Git remembers.
- **Every public function has a JSDoc/TSDoc comment** explaining what it does, what it returns, and what it throws. Internal helpers don't need comments if their names are self-documenting.
- **Names are precise.** Not `data`, `info`, `handle`, `process`, `manager`, `helper`, `util`. Name what the thing IS. `UserAddress`, not `AddressData`. `validateCartCompliance`, not `processCart`.
- **Files stay focused.** One default export per file. If a file exceeds 300 lines, ask whether it should be split.
- **Functions stay focused.** If a function exceeds 50 lines or 3 levels of nesting, refactor before continuing.
- **Errors are typed.** Define error classes per domain (`ComplianceError`, `PaymentError`, `InventoryError`). Never `throw new Error("something happened")`.

### 2. Testing Discipline

- **Every backend module gets unit tests** in the same phase it's built. No "I'll add tests later."
- **Compliance and payments modules require 100% line coverage.** This is non-negotiable — these are the modules that protect the business.
- **Other modules require 80%+ line coverage** on services and controllers.
- **Integration tests** for every API endpoint, using Testcontainers (Postgres + Redis).
- **Tests must run green before the phase is complete.** Run them. Read the output. Fix what's broken. Don't claim "tests pass" without running them.

### 3. Commands That Must Pass Before Phase Completion

Run these in order at the end of every phase. **All must exit 0.** Do not declare the phase complete until they do.

```bash
pnpm install                          # ensure deps resolve
pnpm typecheck                        # tsc --noEmit across all packages
pnpm lint                             # eslint + prettier check
pnpm test                             # vitest run across all packages
pnpm --filter @dankdash/api build     # production build of API
```

If any command fails, you have not finished the phase. Fix the failures. Re-run. Repeat until all green.

### 4. Git Discipline

- **Commit per logical unit of work.** Not one giant "Phase 3 done" commit. Aim for 5-15 commits per phase, each with a clear conventional-commit message.
- **Commit message format:** `<type>(<scope>): <subject>` where type is one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`. Example: `feat(compliance): add per-transaction limit validator`.
- **Never commit secrets.** `.env` files are gitignored. Only commit `.env.example` with placeholder values.
- **One branch per phase:** `phase/01-foundation`, `phase/02-auth-identity`, etc. Open a PR at end of phase. Don't merge yet — wait for user review.

### 5. When You're Stuck

If you genuinely cannot complete a task:

1. **First, re-read the relevant section of the spec.** The answer is probably there.
2. **Check the existing code** for patterns already established in earlier phases.
3. **If still stuck, STOP and write a `BLOCKED.md` file** at the repo root explaining: what you were trying to do, what you tried, what failed, and what decision you need from the user.

**Do not** invent a solution that bypasses the spec. Do not lower the bar to make a test pass. Do not stub something out and claim it's done.

### 6. Cannabis Compliance — Special Rules

This codebase regulates a regulated industry. The following are **never** acceptable:

- Hardcoding cannabis limits to anything other than the MN statutory values (see `compliance.service.ts`)
- Skipping compliance checks "for testing" — use test fixtures that pass legitimately, or test the failure paths explicitly
- Storing PII (DOB, ID document numbers, scan images) in plaintext anywhere outside the encrypted columns
- Logging full ID document numbers, DOB, or scan image content — log hashes or redacted versions only
- Removing or bypassing row-level security policies
- Bypassing the order state machine — every state transition writes an `order_events` row

### 7. Session Pacing

Each phase below is a single Claude Code session. At the end of a phase:

1. Run the green-light commands above.
2. Commit any final changes.
3. Push the branch.
4. Update `PROGRESS.md` (created in Phase 0) with a one-paragraph summary.
5. **Stop and wait.** The user is pacing this manually — do not auto-start the next phase.

---

## Phase Index

| #   | Phase                                          | Est. session | Depends on |
| --- | ---------------------------------------------- | ------------ | ---------- |
| 0   | Foundation & tooling                           | 2h           | —          |
| 1   | Database & migrations                          | 1.5h         | 0          |
| 2   | Auth & identity                                | 2h           | 1          |
| 3   | Compliance engine                              | 2h           | 1          |
| 4   | Dispensaries & catalog                         | 2h           | 2, 3       |
| 5   | Cart & checkout                                | 2.5h         | 3, 4       |
| 6   | Payments (Aeropay)                             | 2h           | 5          |
| 7   | Order lifecycle & state machine                | 2h           | 5, 6       |
| 8   | Dispatch & driver foundation                   | 2h           | 7          |
| 9   | Realtime service (Socket.io)                   | 2h           | 7, 8       |
| 10  | Tracking & geofencing                          | 1.5h         | 8, 9       |
| 11  | Metrc traceability                             | 1.5h         | 7          |
| 12  | Notifications                                  | 1.5h         | 7          |
| 13  | Vendor portal — auth & shell                   | 2h           | 2, 9       |
| 14  | Vendor portal — live order queue               | 2.5h         | 13         |
| 15  | Vendor portal — menu & analytics               | 2h           | 14         |
| 16  | iOS Consumer — foundation                      | 2h           | 9          |
| 17  | iOS Consumer — feed & catalog                  | 2h           | 16         |
| 18  | iOS Consumer — cart, checkout, tracking        | 2.5h         | 17         |
| 19  | iOS Driver — foundation & shift                | 2h           | 16         |
| 20  | iOS Driver — offers, navigation, ID scan       | 2.5h         | 19         |
| 21  | Hardening — security, observability, load test | 2h           | all        |
| 22  | Pre-launch — admin console, runbooks           | 2h           | 21         |
| 23  | Final integration — env validation, cutover    | 1.5h         | 22         |

Total: ~46.5 hours of focused work.

---

# PHASE 0 — Foundation & Tooling

**Goal:** Stand up the monorepo with every piece of tooling a production team uses on day one. After this phase, any subsequent phase can run `pnpm install && pnpm dev` and have a working environment.

## Tasks

### 0.1 — Initialize repo

```bash
mkdir dankdash && cd dankdash
git init
pnpm init
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

Install Turborepo: `pnpm add -D -w turbo`

Create `turbo.json` with `dev`, `build`, `lint`, `typecheck`, `test` pipelines.

### 0.2 — Workspace structure

Create these directories with placeholder `package.json` in each:

```
apps/
  api/                    # NestJS backend
  realtime/               # Socket.io service
  workers/                # BullMQ workers
  portal/                 # Next.js vendor portal
  checkout-web/           # Next.js consumer checkout (Apple workaround)
packages/
  config/                 # shared eslint, tsconfig, prettier
  db/                     # Drizzle schema & migrations
  compliance/             # @dankdash/compliance
  types/                  # shared API types (generated from OpenAPI)
  ui/                     # shared React components for portal & checkout-web
  test-utils/             # Testcontainers helpers, fixtures
docs/
  spec/                   # copy the 4 reference docs here
  adr/                    # architecture decision records (start empty)
infra/
  docker/                 # Dockerfiles
  railway/                # railway.toml configs
  github/                 # composite actions
.github/
  workflows/              # CI workflows
```

### 0.3 — TypeScript configuration

Create `packages/config/tsconfig.base.json` with strict settings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

Each app and package extends this. **Do not loosen these settings later** — strict mode catches real bugs.

### 0.4 — Linting & formatting

Install: `pnpm add -D -w eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier eslint-config-prettier eslint-plugin-import eslint-plugin-unused-imports`

Create `packages/config/eslint.config.js` (flat config) with:

- `@typescript-eslint/recommended-strict`
- `no-console` as error (allow `console.warn`, `console.error` only)
- `no-floating-promises` as error
- `no-misused-promises` as error
- `consistent-type-imports` as error
- `unused-imports/no-unused-imports` as error
- Custom rule: forbid `any` outside test files

Create `.prettierrc.json`: 2-space indent, single quotes, trailing commas, 100 char width.

Create `.editorconfig`.

### 0.5 — Husky + lint-staged + commitlint

```bash
pnpm add -D -w husky lint-staged @commitlint/cli @commitlint/config-conventional
pnpm husky init
```

Pre-commit hook: `pnpm lint-staged`
Commit-msg hook: `npx commitlint --edit $1`

Configure `lint-staged` in root `package.json`:

```json
{
  "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yaml,yml}": ["prettier --write"]
}
```

### 0.6 — Docker Compose for local dev

Create `docker-compose.yml` at root:

- Postgres 16 with PostGIS (`postgis/postgis:16-3.4`)
- Redis 7
- Mailhog for email testing
- LocalStack for S3-compatible storage (R2 substitute locally)

Include healthchecks. Bind to non-default ports (5433, 6380) to avoid clashing with anything on the host. Volumes for persistence.

### 0.7 — Environment configuration

Create `.env.example` at root with every env var the project will need, grouped by section:

```bash
# === Database ===
DATABASE_URL=postgresql://dankdash:dankdash@localhost:5433/dankdash
DATABASE_URL_TEST=postgresql://dankdash:dankdash@localhost:5433/dankdash_test

# === Redis ===
REDIS_URL=redis://localhost:6380

# === Auth ===
JWT_PRIVATE_KEY_BASE64=
JWT_PUBLIC_KEY_BASE64=
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=2592000
PASSWORD_PEPPER=

# === Encryption ===
COLUMN_ENCRYPTION_KEY_BASE64=

# === Object storage ===
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=dankdash-dev

# === Third-party ===
AEROPAY_CLIENT_ID=
AEROPAY_CLIENT_SECRET=
AEROPAY_WEBHOOK_SECRET=
PERSONA_API_KEY=
PERSONA_WEBHOOK_SECRET=
VERIFF_API_KEY=
VERIFF_WEBHOOK_SECRET=
METRC_API_KEY=
METRC_USER_KEY=
MAPBOX_ACCESS_TOKEN=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PROXY_SERVICE_SID=
RESEND_API_KEY=
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=

# === Observability ===
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=debug

# === Feature flags ===
ENABLE_AEROPAY=true
ENABLE_METRC=false
```

Use `dotenv-flow` or NestJS `ConfigModule` with Joi/Zod schema validation. **Fail fast on missing required env vars.** Write a `packages/config/src/env.ts` that validates and exports a typed env object.

### 0.8 — Logging

Add pino to API and workers. Create `packages/config/src/logger.ts`:

- JSON output in production, pretty in dev
- Redaction of PII fields by path: `password`, `password_hash`, `mfa_secret`, `*.dob`, `*.date_of_birth`, `*.scan_image_key`, headers.authorization, headers.cookie

### 0.9 — Error handling primitive

Create `packages/types/src/errors.ts`:

```typescript
export class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}
// concrete: ValidationError, AuthError, ComplianceError, etc.
```

NestJS global exception filter maps `DomainError` to the standardized API error envelope from the OpenAPI spec.

### 0.10 — CI/CD

Create `.github/workflows/ci.yml`:

- Trigger on PR + push to main
- Matrix: Node 20
- Steps: checkout, setup pnpm, install, typecheck, lint, test (with Postgres + Redis services), build
- Cache pnpm store and turbo cache
- Upload coverage to Codecov

Create `.github/workflows/deploy-staging.yml`:

- Trigger on push to `main`
- Deploy API + workers + realtime to Railway staging via Railway CLI
- Deploy portal to Vercel (Vercel handles this automatically; just verify env vars)

Create `.github/workflows/deploy-prod.yml`:

- Manual trigger only (`workflow_dispatch`)
- Same as staging but to production Railway project
- Requires manual approval

### 0.11 — Project root files

Create:

- `README.md` — getting started, common commands, links to spec
- `CLAUDE.md` — coding conventions, this file is the authoritative guide for any Claude Code session
- `PROGRESS.md` — phase tracker, updated at end of each phase
- `LICENSE` — proprietary, all rights reserved
- `.gitignore` — comprehensive (node, IDE, env, build, OS files)
- `.nvmrc` — `20`

`CLAUDE.md` should restate the non-negotiable rules from the top of this document. Future Claude Code sessions will read it first.

### 0.12 — Copy spec docs

Copy the four reference docs into `docs/spec/`:

- `DankDash-Technical-Spec.md`
- `schema.sql`
- `openapi-excerpt.yaml`
- `compliance.service.ts`

### 0.13 — Initial ADRs

Write three short ADRs in `docs/adr/`:

- `0001-modular-monolith.md` — why not microservices
- `0002-drizzle-orm.md` — why Drizzle over Prisma
- `0003-monorepo-turborepo.md` — why monorepo

Each ADR is 1 page max, follows the standard template (Context, Decision, Consequences).

## Phase 0 — Definition of Done

- [ ] `pnpm install` runs clean from a fresh clone
- [ ] `docker compose up` brings up Postgres, Redis, Mailhog
- [ ] `pnpm typecheck` passes (across empty packages)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (even with zero tests)
- [ ] CI workflow runs green on a test PR
- [ ] `.env.example` is comprehensive
- [ ] Pre-commit hooks block commits with lint errors
- [ ] Commitlint blocks non-conventional commit messages
- [ ] All three ADRs written
- [ ] Branch `phase/00-foundation` pushed and PR opened

---

# PHASE 1 — Database & Migrations

**Goal:** Implement the Postgres schema from `docs/spec/schema.sql` using Drizzle, with a working migration pipeline and seed data for development.

## Tasks

### 1.1 — Drizzle setup

In `packages/db`:

```bash
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

Create `drizzle.config.ts` pointing at `src/schema/` for schema files and `src/migrations/` for generated SQL.

### 1.2 — Schema modules

Split the schema into one file per domain matching the spec sections. Do not put everything in one file:

```
packages/db/src/schema/
  identity.ts         # users, sessions, addresses, id_documents
  dispensaries.ts
  catalog.ts          # categories, products, listings, lab results
  cart.ts
  orders.ts           # orders, items, events, status_history
  payments.ts         # methods, transactions, ledger, payouts, refunds
  dispatch.ts         # drivers, shifts, offers, location_history
  compliance.ts       # checks, metrc_transactions, age_verifications
  notifications.ts
  audit.ts
  index.ts            # re-export all
```

Each file uses Drizzle's `pgTable` syntax with full column types matching the spec SQL exactly. Use Drizzle's `customType` for PostGIS `geography(POINT)` and `geography(POLYGON)`.

### 1.3 — Enums

All enums from the spec live in `packages/db/src/schema/enums.ts` using `pgEnum`. Export them. Never inline enum strings elsewhere in the codebase.

### 1.4 — Migrations

Generate the first migration:

```bash
pnpm drizzle-kit generate
```

This produces a SQL file. **Review it carefully** — Drizzle's generator is good but not perfect for PostGIS. Hand-edit if needed to add:

- Extension creation (uuid-ossp, postgis, pg_trgm, pgcrypto, citext)
- The `set_updated_at()` trigger function and triggers on every table that has `updated_at`
- The `products_search_vector_update()` trigger
- All CHECK constraints from the spec
- All partial indexes
- All GIST indexes for PostGIS
- Partitioning declarations and example partitions for `order_events`, `driver_location_history`, `notifications`, `audit_log`
- Row-level security policies

### 1.5 — Migration runner

Create `packages/db/src/migrate.ts` that runs migrations programmatically. Wrap in a CLI:

```bash
pnpm --filter @dankdash/db migrate
pnpm --filter @dankdash/db migrate:rollback
pnpm --filter @dankdash/db migrate:status
```

Use advisory locks (`pg_try_advisory_lock`) to prevent concurrent migration runs in production.

### 1.6 — Connection pool

Create `packages/db/src/client.ts`:

- Uses `postgres` driver in `prepare: true` mode
- Pool size from env (default 10)
- Connection timeout, idle timeout
- Logs slow queries (>500ms) at warn level
- Exports typed `db` instance via `drizzle()`

### 1.7 — Repository pattern

For each domain, create `packages/db/src/repositories/<domain>.repo.ts`:

```typescript
export class UsersRepo {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | null> {
    /* ... */
  }
  async findByEmail(email: string): Promise<User | null> {
    /* ... */
  }
  async create(input: NewUser): Promise<User> {
    /* ... */
  }
  // ... etc.
}
```

**No raw SQL in application code outside repositories.** This is a discipline. If you need raw SQL for performance, encapsulate it in the repo.

### 1.8 — Seed data

Create `packages/db/src/seed.ts` that produces realistic dev data:

- 3 dispensaries with Twin Cities delivery polygons (Minneapolis, St. Paul, Maple Grove)
- ~40 products across all categories with realistic THC/CBD/weight values
- Dispensary listings with prices and inventory
- 5 customer users (1 with verified KYC, 1 pending, 1 banned, 2 normal)
- 3 driver users with backgrounds
- 2 vendor staff users per dispensary
- Realistic operating hours

The seed is **deterministic** — uses a fixed random seed so re-running produces identical IDs. This makes integration tests stable.

CLI: `pnpm --filter @dankdash/db seed`

### 1.9 — Testing infrastructure

In `packages/test-utils`:

- `setupTestDb()` — spins up a Postgres Testcontainer, runs migrations, returns a connection
- `withTransaction(callback)` — wraps a test in a transaction that rolls back, for isolation
- `freezeTime(date)` — wraps date-fns or similar for time-sensitive tests
- `seedScenario(name)` — loads a named fixture scenario from `fixtures/`

### 1.10 — Tests

Write tests in `packages/db/test/`:

- Each repository's basic CRUD operations
- The `set_updated_at` trigger actually updates timestamps
- The `products_search_vector` trigger populates correctly
- CHECK constraints reject invalid data (e.g., beverage with 15mg THC/serving fails to insert)
- RLS policies isolate vendor data (insert two dispensaries' orders, set session var, verify only one returned)
- Partitioned tables: insert rows in two different month partitions, verify correct routing

## Phase 1 — Definition of Done

- [ ] All schema files match the spec SQL exactly
- [ ] `pnpm --filter @dankdash/db migrate` against a fresh database succeeds
- [ ] All CHECK constraints, triggers, indexes, and partitions exist (verify via `psql \d+`)
- [ ] All repositories implemented for tables defined in spec
- [ ] Seed data runs and produces a usable dev database
- [ ] All tests pass with 80%+ coverage on `packages/db`
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green
- [ ] Branch pushed, PR opened

---

# PHASE 2 — Auth & Identity

**Goal:** Implement registration, login, JWT issuance, refresh rotation, KYC orchestration via Persona webhook, MFA for staff, and the session lifecycle.

## Tasks

### 2.1 — NestJS bootstrap (`apps/api`)

```bash
pnpm --filter @dankdash/api add @nestjs/core @nestjs/common @nestjs/platform-fastify @nestjs/config @nestjs/jwt @nestjs/swagger
```

Use **Fastify** adapter, not Express — better performance, better TypeScript story.

Module structure:

```
apps/api/src/
  main.ts
  app.module.ts
  modules/
    auth/
      auth.module.ts
      auth.controller.ts
      auth.service.ts
      strategies/jwt.strategy.ts
      strategies/refresh.strategy.ts
      guards/jwt.guard.ts
      guards/roles.guard.ts
      dto/  (zod schemas + nestjs-zod)
    identity/
      identity.module.ts
      identity.controller.ts
      identity.service.ts
      kyc/persona.service.ts
      kyc/persona.controller.ts  # webhook
  common/
    decorators/        (@CurrentUser, @Roles, @Public)
    filters/global-exception.filter.ts
    interceptors/logging.interceptor.ts
    pipes/zod-validation.pipe.ts
```

### 2.2 — Password hashing

Argon2id. Library: `argon2`. Parameters:

- `type: argon2id`
- `memoryCost: 65536` (64 MB)
- `timeCost: 3`
- `parallelism: 4`

Apply the global `PASSWORD_PEPPER` env var via HMAC-SHA256 over the password before hashing. Pepper rotation procedure documented in a `docs/runbooks/password-pepper-rotation.md`.

### 2.3 — JWT issuance

RS256 with keys from env (base64-encoded). Generate keys in dev via a script `scripts/generate-jwt-keys.ts`.

Access token claims: `sub` (user id), `role`, `dispensary_id` (if staff), `kyc_verified` (bool), `iat`, `exp`, `jti`.
Refresh token: opaque random 256-bit, hashed (SHA-256) before DB storage, stored in `sessions.refresh_token_hash`.

Rotate refresh on every use. Detect reuse — if a hashed refresh appears in a `revoked` row, revoke the entire user's session chain (token replay defense).

### 2.4 — Endpoints

```
POST   /v1/auth/register         body: {email, password, phone, dateOfBirth, firstName, lastName}
POST   /v1/auth/login            body: {email, password}
POST   /v1/auth/refresh          body: {refreshToken}
POST   /v1/auth/logout
POST   /v1/auth/mfa/setup        (authenticated)
POST   /v1/auth/mfa/verify       body: {token}
POST   /v1/identity/kyc/start    -> returns Persona inquiry URL
POST   /v1/identity/kyc/webhook  (no auth, signature-verified)
GET    /v1/me                    -> current user
PATCH  /v1/me
```

Each endpoint:

- DTO validated by Zod via `nestjs-zod`
- Returns the typed response shape from the OpenAPI spec
- Logs the request via interceptor (with PII redaction)
- Increments a Prometheus counter

### 2.5 — Persona KYC integration

`PersonaService`:

- `createInquiry(userId)` — calls Persona API, returns hosted-flow URL with `reference-id=userId`
- `handleWebhook(payload, signature)` — verifies HMAC signature with `PERSONA_WEBHOOK_SECRET`, processes events: `inquiry.completed`, `inquiry.failed`, `inquiry.expired`

On `inquiry.completed`, extract verified DOB, validate ≥21, update `users.kyc_verified_at`, transition `users.status` from `pending_kyc` to `active`.

### 2.6 — Rate limiting

Use `@nestjs/throttler` with Redis backend:

- `/v1/auth/login`: 5/min per IP, 10/hour per email
- `/v1/auth/register`: 3/hour per IP
- `/v1/auth/refresh`: 60/min per user
- Other endpoints: default 120/min per user

### 2.7 — MFA (TOTP)

`speakeasy` for TOTP. Required for any user with role in (`manager`, `owner`, `admin`, `superadmin`). Optional for others.

`mfa_secret_enc` stored in users table via column-level encryption (envelope encryption with `COLUMN_ENCRYPTION_KEY_BASE64`). Implement encryption helper in `packages/db/src/encryption.ts`.

### 2.8 — Tests

Unit tests (`apps/api/test/unit/`):

- AuthService: password hashing, JWT signing, refresh rotation logic
- Persona webhook signature verification

Integration tests (`apps/api/test/integration/`):

- Full register → KYC webhook → login → access protected endpoint flow
- Refresh token rotation
- Refresh token reuse detection (mark as revoked, attempt reuse, expect cascade revocation)
- Rate limiting (use fake Redis or real one in Testcontainers)
- MFA setup and verification

E2E test:

- Persona inquiry stub responding with success/failure scenarios

## Phase 2 — Definition of Done

- [ ] All 9 endpoints implemented and tested
- [ ] JWTs signed with RS256, validated correctly
- [ ] Refresh rotation working with reuse detection
- [ ] Persona webhook verifies signatures
- [ ] MFA works end-to-end for staff
- [ ] Rate limits enforced
- [ ] Coverage ≥80% on auth and identity modules
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 3 — Compliance Engine

**Goal:** Implement `@dankdash/compliance` as a standalone package with the reference service from the spec, plus exhaustive tests covering every MN statutory rule.

## Tasks

### 3.1 — Package setup

`packages/compliance/` — depends on `@dankdash/types` only (no DB dependency, no HTTP dependency). Pure functions where possible.

### 3.2 — Port the reference implementation

Copy `docs/spec/compliance.service.ts` into `packages/compliance/src/compliance.service.ts`. Refactor:

- Statutory limits in `constants.ts` with full citations
- Each rule in `rules/<rule-name>.ts` exporting a pure function
- `evaluateCart()` composes the rules

Rule files:

```
rules/
  check-age.ts
  check-kyc.ts
  check-license.ts
  check-hours.ts
  check-geofence.ts
  check-per-transaction-limits.ts
  check-product-provenance.ts
```

Each rule has signature `(ctx: EvaluationContext) => RuleResult`.

### 3.3 — Geofencing helper

`packages/compliance/src/geo.ts`:

- `pointInPolygon(point, polygon)` — exported for testing
- In production, the consuming code uses PostGIS `ST_Contains` via the repo layer; this is the fallback for cases where Postgres isn't available (e.g., client-side preview)

### 3.4 — Cart math

`packages/compliance/src/cart-math.ts`:

- `computeCartTotals(lines)` — returns `{ flowerGrams, concentrateGrams, edibleThcMg }`
- Handles all product types correctly per spec
- Uses `Decimal` from `decimal.js` for precision — never plain JS numbers for cannabis weight math

### 3.5 — Tests — exhaustive

This is the most-tested module in the codebase. Tests in `packages/compliance/test/`:

**Age:**

- Exactly 21 today → passes
- 20 years 364 days → fails
- DOB null → fails
- Future DOB → fails (data corruption defense)

**KYC:**

- Verified → passes
- Not verified → fails

**License:**

- Expires tomorrow → passes
- Expired yesterday → fails

**Hours:**

- 7:59 AM → fails (before state earliest)
- 8:00 AM → passes (state earliest)
- 1:59 AM next day → passes (state latest)
- 2:00 AM → fails (state latest)
- Dispensary closed today (null) → fails
- Dispensary hours 9-21, current time 22:00 → fails (dispensary closed even though within state hours)
- Test timezone handling: Minneapolis (CST/CDT) — DST transition correctness

**Geofence:**

- Address inside polygon → passes
- Address outside polygon → fails
- Address on polygon boundary → defined behavior (test what it does)
- WI / IA / SD / ND addresses → all fail (interstate)

**Per-transaction limits:**

- 1.99 oz flower → passes (under 2 oz / 56.7g)
- 2.0 oz flower → passes (exactly at limit)
- 2.01 oz flower → fails
- 56.7g exactly → passes
- 56.701g → fails
- 7.99g concentrate → passes
- 8.001g concentrate → fails
- 799mg edibles → passes
- 801mg edibles → fails
- Mix: 1 oz flower + 4g concentrate + 400mg edibles → passes
- Edge: 5 vapes at 1.7g each = 8.5g concentrate → fails
- Beverages: 2 cans × 100mg → fails (edibles category, exceeds 800mg)
- Beverages: 2 cans × 10mg → passes (within edibles limit)
- Combo of edibles and tinctures both count toward 800mg edible THC limit

**Product provenance:**

- Beverage with 11mg THC/serving → fails
- Beverage with 10mg THC/serving → passes (at cap)
- Beverage with 3 servings → fails
- Beverage with 2 servings → passes (at cap)
- Beverage with no `thcMgPerServing` field → fails (data integrity)

**Composite:**

- Cart that passes all rules → overall passed=true
- Cart that fails one rule → overall passed=false, only failing rule's `passed=false`
- Empty cart → defined behavior (passes — there's nothing to violate)
- Exception thrown internally → fail closed, passed=false

**Determinism:**

- Same inputs → same outputs across 1000 runs
- Cart totals reproducible to 3 decimal places

### 3.6 — Property-based tests

Use `fast-check`:

- For any cart with all line totals under limits → composite limit check passes
- For any cart with at least one limit exceeded → composite check fails

### 3.7 — Performance test

Single `evaluateCart` call: <5ms p99 with 50 line items. Benchmark in tests.

## Phase 3 — Definition of Done

- [ ] All rules implemented as pure functions
- [ ] 100% line coverage on `packages/compliance`
- [ ] Every test from §3.5 written and passing
- [ ] Property-based tests passing
- [ ] Performance benchmark passes
- [ ] Statute citations in code comments
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 4 — Dispensaries & Catalog

**Goal:** Implement vendor onboarding (admin-driven for v1), dispensary CRUD, product catalog, dispensary listings, lab results, and search.

## Tasks

### 4.1 — Modules

```
apps/api/src/modules/
  dispensaries/
  catalog/   (products, categories, lab results)
  listings/  (dispensary-scoped pricing/inventory)
  search/    (product search, dispensary feed)
```

### 4.2 — Customer-facing endpoints

```
GET    /v1/dispensaries?lat=&lng=        # only stores serving that point
GET    /v1/dispensaries/:id
GET    /v1/dispensaries/:id/menu
GET    /v1/products/:id
GET    /v1/products/search?q=&category=&strain_type=&dispensary_id=
GET    /v1/categories
```

`GET /v1/dispensaries?lat=&lng=` uses PostGIS `ST_Contains` against `delivery_polygon`. Composed query returns dispensaries serving the point with their hours-status (open now / opens at X) computed.

`GET /v1/products/search` uses the `tsvector` index. Returns paginated results with facets (category counts, strain type counts).

### 4.3 — Admin endpoints (locked to `admin` and `superadmin`)

```
POST   /v1/admin/dispensaries
PATCH  /v1/admin/dispensaries/:id
POST   /v1/admin/dispensaries/:id/activate
POST   /v1/admin/dispensaries/:id/suspend
POST   /v1/admin/products
PATCH  /v1/admin/products/:id
POST   /v1/admin/products/:id/lab-results
POST   /v1/admin/categories
```

Activating a dispensary validates: license_expires_at > now, has delivery polygon, has hours, has at least one staff member with role=owner.

### 4.4 — Vendor endpoints (locked to dispensary staff)

```
GET    /v1/vendor/listings
POST   /v1/vendor/listings
PATCH  /v1/vendor/listings/:id
DELETE /v1/vendor/listings/:id
```

RLS automatically scopes these to the vendor's `dispensary_id` (verify by trying to PATCH another dispensary's listing — must return 404).

### 4.5 — Dispensary hours computation

`packages/dispensaries/src/hours.ts`:

- `isOpenAt(hoursJson, dateTime, timezone)` — uses the same logic as the compliance hours check but exported for "open now" UI labels
- `nextOpenAt(hoursJson, dateTime, timezone)` — returns when the store next opens
- Handles overnight hours, holidays (separate `dispensary_holidays` future table — out of scope for now), DST

### 4.6 — Image uploads

`packages/storage/src/r2.ts`:

- `presignUpload(key, contentType, sizeLimit)` — returns presigned POST for direct browser/iOS upload to R2
- `getPublicUrl(key)` — for image rendering via Cloudflare CDN

Admin and vendor endpoints to add product/dispensary images use this presigned-upload pattern, never proxying file bytes through the API.

### 4.7 — Catalog cache

Frequently-accessed catalog data (dispensary feed, dispensary menu) cached in Redis with 60s TTL. Cache invalidation on listing/dispensary updates via event emission. Cache keys versioned (`v1:dispensaries:feed:...`) for safe rollouts.

### 4.8 — Tests

- All endpoints have integration tests with seed data
- Geo-query: insert dispensary with polygon, query a point inside and outside, verify
- Search: insert products with varied names/descriptions, query, verify relevance ranking
- RLS: create staff for dispensary A, attempt to access dispensary B's listing, expect 404
- Activation validation: try to activate incomplete dispensary, expect 422

## Phase 4 — Definition of Done

- [ ] All endpoints implemented with auth/RLS enforced
- [ ] PostGIS geo-queries working
- [ ] Product search returns relevance-ranked results
- [ ] R2 presigned uploads working in dev (against LocalStack)
- [ ] Redis cache layer functional with invalidation
- [ ] Coverage ≥80%
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 5 — Cart & Checkout

**Goal:** Cart CRUD, real-time inventory holds, compliance preview, and checkout that creates an `order` row with a snapshot.

## Tasks

### 5.1 — Cart endpoints

```
POST   /v1/carts                       # create cart for dispensary
GET    /v1/carts/:id
POST   /v1/carts/:id/items
PATCH  /v1/carts/:id/items/:itemId
DELETE /v1/carts/:id/items/:itemId
POST   /v1/carts/:id/validate          # compliance preview, no DB writes
POST   /v1/carts/:id/checkout          # creates order
DELETE /v1/carts/:id
```

Carts are dispensary-scoped (one cart per user per dispensary, UNIQUE constraint). Carts expire after 4 hours.

### 5.2 — Cart compliance preview

`POST /v1/carts/:id/validate`:

- Loads cart with items + listings + products
- Loads user (DOB, KYC status)
- Loads dispensary (license, hours, polygon)
- Loads delivery address candidate from query param
- Calls `ComplianceService.evaluateCart`
- Returns the evaluation result, never mutates state
- Idempotent — clients can call this on every cart change

### 5.3 — Checkout flow

`POST /v1/carts/:id/checkout`:

This is the single most important transaction in the system. It must be atomic.

```typescript
async checkout(cartId: string, input: CheckoutInput): Promise<{order: Order, paymentIntent: PaymentIntent}> {
  return this.db.transaction(async (tx) => {
    // 1. Lock cart row FOR UPDATE
    const cart = await this.cartsRepo.findByIdForUpdate(tx, cartId);

    // 2. Reload all related entities within the transaction
    const user = await this.usersRepo.findById(tx, cart.userId);
    const dispensary = await this.dispensariesRepo.findById(tx, cart.dispensaryId);
    const address = await this.addressesRepo.findById(tx, input.deliveryAddressId);
    const lines = await this.cartItemsRepo.findByCartId(tx, cartId);

    // 3. Lock listings FOR UPDATE and verify inventory
    const listings = await this.listingsRepo.findByIdsForUpdate(tx, lines.map(l => l.listingId));
    for (const line of lines) {
      const listing = listings.find(l => l.id === line.listingId);
      if (!listing || listing.quantityAvailable < line.quantity) {
        throw new InventoryError(`Insufficient inventory for listing ${line.listingId}`);
      }
    }

    // 4. Run compliance — server is authoritative
    const evaluation = this.complianceService.evaluateCart({...});
    if (!evaluation.passed) {
      throw new ComplianceError('Cart fails compliance', { evaluation });
    }

    // 5. Compute prices, taxes
    const pricing = this.pricingService.computeOrderTotals({...});

    // 6. Insert order, order_items, compliance_check, order_events
    const order = await this.ordersRepo.create(tx, {...});

    // 7. Decrement inventory
    await this.listingsRepo.decrementInventory(tx, ...);

    // 8. Delete cart
    await this.cartsRepo.deleteById(tx, cartId);

    // 9. Create payment intent (Aeropay - stubbed in this phase)
    const paymentIntent = await this.paymentsService.createIntent(tx, order);

    // 10. Write to ledger (pending_authorization entry)
    await this.ledgerService.recordOrderPlaced(tx, order);

    return { order, paymentIntent };
  });
}
```

If any step throws, the transaction rolls back. No partial state.

### 5.4 — Pricing service

`packages/pricing/`:

- `computeOrderTotals(lines, deliveryFee, tip)` — returns `{ subtotalCents, cannabisTaxCents, salesTaxCents, deliveryFeeCents, driverTipCents, totalCents }`
- Cannabis tax: 10% of subtotal (Minn. Stat. § 295.81)
- State sales tax: 6.875%
- Local sales tax: configurable per dispensary's municipality
- Tips: pass-through to driver
- All math in cents, integer-only, banker's rounding for split fractions

### 5.5 — Inventory holds (lightweight)

V1 doesn't reserve inventory on cart add — just at checkout. This is acceptable for low-volume launch. Phase 8+ will add Redis-backed reservations when contention warrants it.

### 5.6 — Order short codes

`packages/utils/src/short-code.ts` — produces 6-character codes like `3F9A2K` from Crockford base32. Collision-checked against existing orders within a 30-day window.

### 5.7 — Tests

- Happy path: build cart, validate, checkout, verify order created with snapshot
- Compliance fails: cart with 900mg edibles, expect 422 with compliance error envelope
- Inventory fails: cart with quantity 5 but listing has 3 available, expect 409
- Concurrency: two simultaneous checkouts of the same listing (race) — exactly one succeeds, other gets 409
- Expired cart: cart with expires_at < now, expect 410
- Cross-user: User A tries to checkout User B's cart, expect 404 (not 403, to avoid info leak)
- Transaction rollback: simulate failure at step 7, verify no order/no inventory decrement

## Phase 5 — Definition of Done

- [ ] Cart CRUD complete
- [ ] Compliance preview endpoint working
- [ ] Checkout creates order, decrements inventory, deletes cart, writes ledger, all in one transaction
- [ ] Concurrency tests passing (use Testcontainers + parallel client connections)
- [ ] Coverage ≥85% on cart and order modules
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 6 — Payments (Aeropay)

**Goal:** Aeropay integration for ACH payments, webhook handling, payment lifecycle, refunds, and ledger entries.

## Tasks

### 6.1 — Aeropay client

`packages/aeropay/`:

- Typed client wrapping Aeropay's REST API
- Auth: OAuth client credentials, token cached in Redis with refresh-before-expiry
- Methods: `linkBankAccount`, `createPayment`, `getPayment`, `cancelPayment`, `refundPayment`, `createPayout`
- All HTTP via `undici` with timeout and retry policy
- Webhook signature verification

### 6.2 — Payment methods

```
GET    /v1/payment-methods
POST   /v1/payment-methods/aeropay/link    # returns Aeropay hosted link URL
POST   /v1/payment-methods/aeropay/webhook # bank link complete
DELETE /v1/payment-methods/:id
```

### 6.3 — Payment lifecycle

States: `initiated` → `authorized` → `settled` (or `failed` / `canceled`).

Flow:

1. Checkout creates `payment_transactions` row in `initiated` state
2. iOS or web app shows Aeropay confirm UI (uses `paymentIntent.clientSecret`)
3. Customer confirms in Aeropay-hosted flow
4. Aeropay calls our webhook with `payment.authorized`
5. Order transitions to `accepted`-eligible (vendor can now accept)
6. Aeropay calls webhook again on `payment.settled` (T+1 to T+3 for ACH)
7. Ledger entries written on each transition

### 6.4 — Ledger entries

On `payment.settled`:

```
DEBIT  aeropay_clearing       total_cents
CREDIT customer (user)        total_cents     # customer's account is now "paid"

DEBIT  customer               total_cents
CREDIT dispensary             subtotal - platform_fee
CREDIT platform_revenue       platform_fee
CREDIT cannabis_tax           cannabis_tax_cents
CREDIT sales_tax              sales_tax_cents
CREDIT driver (if assigned)   driver_tip + delivery_fee
```

Double-entry: every transaction sums to zero across debits and credits. Daily reconciliation job verifies this.

### 6.5 — Refunds

```
POST   /v1/vendor/orders/:id/refund   { amountCents, reasonCode, reasonNotes }
POST   /v1/admin/refunds/:id/approve
```

Refunds >$50 require admin approval (separation of duties — the `refunds.initiated_by != approved_by` CHECK is enforced in DB).

Refund triggers Aeropay reverse-ACH plus reverse ledger entries.

### 6.6 — Payouts (cron job)

`apps/workers/src/jobs/payout.job.ts`:

- Daily at 03:00 Central
- For each dispensary, sum settled orders since last payout, create `payouts` row, call Aeropay payout API
- Same for drivers (sum delivery fees + tips)
- Idempotent — uses period_start/period_end uniqueness

### 6.7 — Webhook hardening

Aeropay webhook endpoint:

- Verifies HMAC signature with `AEROPAY_WEBHOOK_SECRET`
- Idempotency key: store `provider_ref` in `payment_transactions`; re-receiving the same event is a no-op
- Idempotency table: `webhook_events_processed` with TTL of 30 days

### 6.8 — Tests

- Mock Aeropay server (using `msw` or a real test sandbox)
- Full payment lifecycle: create → webhook authorized → webhook settled → ledger verified
- Webhook signature invalid → 401
- Webhook replay → idempotent (no double-ledger)
- Refund flow with admin approval required
- Ledger balance check: sum debits = sum credits for any random sample of orders
- Payout job: setup data, run job, verify payouts created

## Phase 6 — Definition of Done

- [ ] Aeropay client typed and tested
- [ ] All payment endpoints working
- [ ] Webhook signature verification working
- [ ] Ledger double-entry invariant verified by tests
- [ ] Refund flow complete with admin approval
- [ ] Payout cron job functional
- [ ] 100% line coverage on `packages/aeropay` and `payments` module
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 7 — Order Lifecycle & State Machine

**Goal:** Implement the order state machine, every transition endpoint, and the event log.

## Tasks

### 7.1 — XState machine

`packages/orders/src/order-machine.ts`:

- Uses XState v5
- Mirrors the enum from the spec exactly
- Transitions:
  - `placed` → `accepted` (vendor action) or `rejected` (vendor) or `canceled` (customer, pre-acceptance only)
  - `accepted` → `prepping` (vendor)
  - `prepping` → `ready_for_pickup` (vendor)
  - `ready_for_pickup` → `awaiting_driver` (system, dispatch trigger)
  - `awaiting_driver` → `driver_assigned` (system, offer accepted)
  - `driver_assigned` → `en_route_pickup` (driver)
  - `en_route_pickup` → `picked_up` (driver, with vendor handoff)
  - `picked_up` → `en_route_dropoff` (driver)
  - `en_route_dropoff` → `arrived_at_dropoff` (driver / geofence trigger)
  - `arrived_at_dropoff` → `id_scan_pending` (driver initiates scan)
  - `id_scan_pending` → `id_scan_passed` or `id_scan_failed`
  - `id_scan_passed` → `delivered` (driver confirms)
  - `id_scan_failed` → `returned_to_store` (driver returns) or retry → `id_scan_pending`

### 7.2 — Transition service

`OrderTransitionService.transition(orderId, event, actor)`:

- Loads order with row lock
- Verifies actor authorization (e.g., only assigned driver can call `picked_up`)
- Runs XState machine to compute next state
- Updates `orders.status`, `orders.status_changed_at`, the timestamp field for that state (e.g., `accepted_at`)
- Inserts `order_events` row
- Inserts `order_status_history` row
- Emits domain event (consumed by realtime, notifications, dispatch)
- All within one transaction

### 7.3 — Vendor endpoints

```
POST   /v1/vendor/orders/:id/accept
POST   /v1/vendor/orders/:id/reject       { reason }
POST   /v1/vendor/orders/:id/prepped
POST   /v1/vendor/orders/:id/ready
POST   /v1/vendor/orders/:id/handoff      # driver confirmed pickup
```

### 7.4 — Customer endpoints

```
GET    /v1/orders                   # paginated, mine only
GET    /v1/orders/:id
POST   /v1/orders/:id/cancel        # only allowed pre-acceptance
POST   /v1/orders/:id/rate          { rating, review, driverRating, dispensaryRating }
```

### 7.5 — Domain events

`packages/events/src/`:

- Define event types: `OrderPlaced`, `OrderAccepted`, `OrderReady`, `OrderPickedUp`, `OrderDelivered`, etc.
- Use NestJS `EventEmitter2` for in-process dispatch
- Each event handler is small and focused; cross-module side effects go through events, not direct service calls

### 7.6 — Tests

- Each state transition: happy path
- Each state transition: invalid transition (e.g., trying to go from `placed` to `delivered`) returns 422
- Authorization: customer can't accept their own order; vendor of dispensary A can't accept an order for dispensary B
- Cancel only before acceptance
- Rate only after delivery
- Order events table has one row per transition with correct actor + payload
- Concurrency: two simultaneous accepts → exactly one succeeds (row lock)

## Phase 7 — Definition of Done

- [ ] XState machine matches spec
- [ ] All transitions implemented with authorization
- [ ] Event log populated on every transition
- [ ] Domain events emitting and being consumed
- [ ] Coverage ≥85%
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 8 — Dispatch & Driver Foundation

**Goal:** Driver onboarding, shifts, status management, and the dispatch algorithm that creates offers when orders reach `ready_for_pickup`.

## Tasks

### 8.1 — Driver onboarding endpoints

```
POST   /v1/admin/drivers              # admin approves driver application
PATCH  /v1/admin/drivers/:id/status   # active, suspended
```

### 8.2 — Shift management

```
POST   /v1/driver/shift/start         { startingLocation }
POST   /v1/driver/shift/end
POST   /v1/driver/status              { status: online | offline | on_break }
```

### 8.3 — Dispatch algorithm

When an order's domain event `OrderReady` fires:

```
1. Find drivers within 10mi of the dispensary, status = online, no current_order_id
2. Score each driver:
   - distance to dispensary (closer = better)
   - rating
   - recency of last completed delivery (avoid starving newer drivers)
3. Offer to top-scored driver, expires in 30s
4. If declined or expired, offer to next driver
5. If no driver accepts within 3 minutes, mark order as `dispatch_failed` and alert admin
```

`DispatchService` lives in `apps/workers/` so it can be scaled independently. Listens to domain events via Redis Streams.

### 8.4 — Offer endpoints

```
POST   /v1/driver/offers/:id/accept
POST   /v1/driver/offers/:id/decline { reason }
```

Accept handler:

- Locks the offer row
- Verifies offer is still in `offered` state and not expired
- Updates driver.current_order_id, driver.current_status = 'en_route_pickup'
- Updates order.driver_id, order.status = 'driver_assigned'
- Cancels all other pending offers for this order
- Emits OfferAccepted event

### 8.5 — Driver app endpoints

```
GET    /v1/driver/current-route          # current order with pickup + dropoff
GET    /v1/driver/earnings?period=
GET    /v1/driver/shifts
```

### 8.6 — Tests

- Dispatch picks the right driver based on scoring
- Concurrent accept attempts: only one driver gets the order
- Offer expiry: 30s passes, offer marked expired, next driver offered
- No drivers available: order eventually marked `dispatch_failed`
- Driver can only see their own offers/earnings
- Coverage ≥80%

## Phase 8 — Definition of Done

- [ ] Driver onboarding + shift management working
- [ ] Dispatch algorithm tested with realistic scenarios
- [ ] Offer system handles concurrency correctly
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 9 — Realtime Service (Socket.io)

**Goal:** Standalone Socket.io service on Railway that pushes order updates, dispatch offers, and driver locations to the right rooms.

## Tasks

### 9.1 — Service bootstrap (`apps/realtime`)

Express + Socket.io. Three namespaces: `/customer`, `/vendor`, `/driver`.

JWT auth on connect — uses the same RS256 public key as the API. Reject unauthenticated connections.

Redis adapter for horizontal scaling. Sticky sessions handled by Railway's TCP proxy.

### 9.2 — Rooms

- Customer namespace: each user joins `user:{userId}`
- Vendor namespace: each staff joins `dispensary:{dispensaryId}`
- Driver namespace: each driver joins `driver:{driverId}`

### 9.3 — Event bus

API and workers emit events to Redis Streams. Realtime service consumes the streams and broadcasts to rooms.

Events to broadcast:

- `order:created` → vendor room
- `order:status_changed` → user + dispensary + driver rooms
- `driver:location` → user room (customer of that order only)
- `offer:new` → driver room
- `offer:expired` → driver room

### 9.4 — Client-to-server events

- `driver:location:update` — driver pings location (rate-limited to 1/sec, written to Redis Stream, batch-persisted by a worker)
- `driver:heartbeat` — keepalive

### 9.5 — Tests

- Authenticated connection works; unauthenticated rejected
- Customer can only join their own user room (not another user's)
- Vendor can only join their dispensary's room
- Event published to Redis Stream → received by correct room subscribers
- Driver location rate limiting works
- Reconnection state correct

## Phase 9 — Definition of Done

- [ ] Realtime service runs alongside API
- [ ] All event types broadcasting correctly
- [ ] Redis adapter enabling horizontal scale
- [ ] Auth and room isolation tested
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 10 — Tracking & Geofencing

**Goal:** Persist driver location history, compute live ETAs, fire `arrived_at_dropoff` event when driver enters address geofence.

## Tasks

### 10.1 — Location ingestion worker

`apps/workers/src/jobs/location-ingest.job.ts`:

- Consumes Redis Stream `driver_locations`
- Batches inserts into `driver_location_history` (use `INSERT ... VALUES (...), (...)` with batch size 100 or 500ms)
- Updates `drivers.current_location` and `drivers.current_location_updated_at`

### 10.2 — Geofence triggers

When location updates with `order_id`:

- If driver is within 50m of the order's delivery address → emit `DriverArrived` event → API transitions order to `arrived_at_dropoff`
- Idempotent: only fire once per order

### 10.3 — ETA computation

`ETAService.computeETA(driverLocation, destination)`:

- Use Mapbox Directions API
- Cache by (driver-grid-cell, destination-grid-cell) for 60s — drivers near each other heading to same destination get cached result
- Fall back to haversine × 0.8 if Mapbox unavailable

ETA emitted alongside driver location updates to the customer room.

### 10.4 — Partition management

Cron job rotates `driver_location_history` partitions weekly:

- Create next week's partition
- Detach partitions older than 90 days
- Archive detached partitions to R2 as Parquet (use `duckdb` or `parquet-wasm`)
- Drop archived partitions

### 10.5 — Tests

- Stream ingestion writes correct rows
- Geofence trigger fires exactly once per order
- ETA cache hits and misses
- Partition rotation creates new partitions correctly

## Phase 10 — Definition of Done

- [ ] Location worker ingesting at ≥500 msg/sec in load test
- [ ] Geofence trigger working
- [ ] ETA computation cached and resilient
- [ ] Partition management automated
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 11 — Metrc Traceability

**Goal:** Report every completed sale to Minnesota Metrc, with retry on failure and reconciliation.

## Tasks

### 11.1 — Metrc client

`packages/metrc/`:

- Typed client for Metrc MN API (basic auth: user key + API key)
- Methods: `createReceipt`, `getReceipt`, `voidReceipt`, `listActivePackages`
- Per-facility credentials (one set per dispensary, encrypted in `dispensaries.metrc_api_key_enc`)

### 11.2 — Reporting job

On `OrderDelivered` event:

- Create `metrc_transactions` row in `pending`
- Enqueue BullMQ job
- Job calls `metrc.createReceipt` with order items and package tags
- On success, mark `reported`, save `metrc_receipt_id`
- On failure, retry with exponential backoff (1m, 5m, 15m, 1h, 6h, 24h)
- After 24h of failures, mark as `failed` and alert admin

### 11.3 — Reconciliation job

Daily at 04:00 Central:

- Pull last 7 days of Metrc receipts for each dispensary
- Compare to `metrc_transactions` table
- Flag discrepancies (we have receipt for order X but Metrc doesn't, or vice versa)
- Email report to admin

### 11.4 — Tests

- Mock Metrc API (sandbox preferred)
- Receipt creation success path
- Retry on transient failure
- Permanent failure handling
- Reconciliation correctly flags discrepancies

## Phase 11 — Definition of Done

- [ ] Every delivered order reports to Metrc
- [ ] Retry logic verified
- [ ] Reconciliation job functional
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 12 — Notifications

**Goal:** Push, SMS, email — all driven by domain events, with templates, deduplication, and provider failure handling.

## Tasks

### 12.1 — Notification service

`apps/api/src/modules/notifications/`:

- Listens to domain events
- Resolves notification recipients and templates
- Enqueues delivery jobs in BullMQ

### 12.2 — Providers

`packages/notifications/src/providers/`:

- `apns.provider.ts` — using `node-apn`, JWT-based auth
- `twilio.provider.ts` — SMS + Proxy (masked numbers for driver-customer calls)
- `resend.provider.ts` — transactional email with React Email templates

### 12.3 — Templates

`packages/notifications/src/templates/`:

- One file per notification (e.g., `order-accepted.ts`) exporting push/sms/email variants
- Internationalization-ready (i18next, English-only for v1)

### 12.4 — Push token management

```
POST   /v1/me/push-tokens     { deviceId, apnsToken, appVariant }
DELETE /v1/me/push-tokens/:id
```

Tokens revoked on logout. Failed deliveries (`BadDeviceToken`) mark token inactive.

### 12.5 — Deduplication

Notification idempotency key: `{userId}:{eventType}:{eventId}`. Stored in Redis 24h. Same event re-published won't send duplicate notifications.

### 12.6 — Tests

- Each event triggers correct notification on correct channel
- Provider failure → marked failed, alertable
- Idempotency: re-publish event, expect only one delivery
- APNs token retired on bad-token response

## Phase 12 — Definition of Done

- [ ] Push, SMS, email delivering in dev
- [ ] All 15+ notification templates implemented
- [ ] Idempotency working
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 13 — Vendor Portal: Auth & Shell

**Goal:** Next.js portal scaffold, authentication, navigation, settings shell.

## Tasks

### 13.1 — Next.js app

`apps/portal/`:

- Next.js 15 App Router
- Auth.js v5 with custom credentials provider that calls our API
- Tailwind + shadcn/ui setup (`pnpm dlx shadcn init`)
- Theme tokens matching the dark-green + cream brand
- `app/layout.tsx` with sidebar nav, top bar with dispensary switcher (for owners with multiple stores — future)

### 13.2 — Routes

```
/login
/two-factor
/dashboard
/orders
/menu
/staff
/payouts
/analytics
/settings
  /settings/store
  /settings/integrations
  /settings/compliance
```

### 13.3 — Auth flow

- Login → calls API → receives JWT → stored in HTTP-only cookie via Auth.js
- Middleware redirects unauthenticated to /login
- Role check: portal requires `budtender`, `manager`, or `owner`
- 2FA enforcement for managers and owners

### 13.4 — API client

`apps/portal/src/lib/api.ts`:

- Typed client generated from OpenAPI spec
- Automatic token refresh on 401
- Server actions for mutations
- TanStack Query for reads

### 13.5 — Realtime client

`apps/portal/src/lib/realtime.ts`:

- Socket.io client wrapper
- Connects to `/vendor` namespace with JWT
- Auto-reconnect with exponential backoff
- Exposes a React hook `useRealtimeOrders()` that subscribes to events

### 13.6 — Tests

- Playwright: login flow
- Playwright: navigation to all routes (smoke)
- Playwright: 2FA challenge for manager role
- Component tests with Vitest + React Testing Library

## Phase 13 — Definition of Done

- [ ] Portal builds and runs
- [ ] Login/logout/2FA working
- [ ] All routes have placeholder pages
- [ ] Realtime connection established
- [ ] Coverage ≥70% on portal (lower bar because UI)
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 14 — Vendor Portal: Live Order Queue

**Goal:** The signature screen. Four-column live order board with realtime updates.

## Tasks

### 14.1 — Order queue page

`apps/portal/src/app/orders/page.tsx`:

- Server component fetches initial orders
- Client component subscribes to realtime updates
- Four columns: New, Prepping, Ready, Out for Delivery
- Cards: short code, customer name, item count, subtotal, time-since-placed
- Time badges: green <5min, yellow 5-10min, red >10min
- Drag-and-drop between columns using `@dnd-kit/core`
- Confirmation modal on backwards moves

### 14.2 — Order detail drawer

Tapping a card opens a slide-out drawer with full order details: items, prices, customer info, address, payment status, driver status if assigned.

### 14.3 — Audio + browser notifications

- Configurable chime on new order (Web Audio API)
- Browser notification permission requested on session start
- Cannot mute notifications per-account, only per-session

### 14.4 — Polling fallback

If WebSocket disconnects, fall back to polling `/v1/vendor/orders?status=active` every 15s. Show "Live" / "Polling" indicator.

### 14.5 — Order action endpoints (wired up)

Accept, reject, prepped, ready, handoff — all wired to the corresponding API endpoints from Phase 7.

### 14.6 — Tests

- Component tests for each card state
- Playwright: receive new order via realtime, verify it appears
- Playwright: drag card from New → Prepping, verify API call
- Playwright: WebSocket disconnects, polling kicks in

## Phase 14 — Definition of Done

- [ ] Order queue fully functional
- [ ] Realtime + polling fallback both working
- [ ] All actions wired
- [ ] Accessibility audit (axe-core): zero violations
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 15 — Vendor Portal: Menu & Analytics

**Goal:** Menu management UI, payouts view, analytics dashboard, staff management, settings pages.

## Tasks

### 15.1 — Menu page

- Listings table with inline edit (price, quantity, active toggle)
- POS sync status banner ("Last synced 2m ago" / "Sync failed, retry")
- Manual sync trigger
- Override controls (hide from DankDash, custom photo, custom description)

### 15.2 — Analytics dashboard

`/analytics/sales`:

- Revenue this period vs last
- Order count, AOV
- Hourly heatmap (when orders come in)
- Top products
- Use Recharts; all queries server components

`/analytics/products`:

- Best sellers, dead inventory
- Reorder rate

### 15.3 — Payouts page

- List of payouts with status, period, amounts
- Detail view showing constituent orders

### 15.4 — Staff page

- Invite, edit role, remove
- Activity log per staff member

### 15.5 — Settings

- Store: hours, delivery polygon (with embedded Mapbox edit), branding, payment account
- Integrations: POS connect/disconnect, Metrc credentials
- Compliance: license docs upload, expiration warnings

### 15.6 — Tests

- Component tests for each page
- Playwright happy paths
- Date range picker behavior

## Phase 15 — Definition of Done

- [ ] All portal pages functional
- [ ] Charts render correctly across date ranges
- [ ] Settings persist
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 16 — iOS Consumer: Foundation

**Goal:** Xcode project scaffold, TCA architecture, networking, design system, auth screens, age gate.

## Tasks

### 16.1 — Xcode project

Single Xcode workspace with two app targets: `DankDash` and `DankDasher`. Shared frameworks: `DankDashCore`, `DankDashUI`, `DankDashNetwork`.

Use Tuist or XcodeGen for project generation — `.xcodeproj` is committed but generated from a manifest.

### 16.2 — Design system

`DankDashUI`:

- Color tokens matching spec (#1A4314, etc.)
- Typography scale
- Spacing scale
- Reusable components: `DankButton`, `DankCard`, `DankInput`, `DankSheet`, `DankBadge`, etc.
- SwiftUI ViewModifier extensions
- Dark mode support (cannabis users use this app late — dark mode matters)

### 16.3 — TCA setup

Each feature is a TCA `Reducer`:

```
Features/
  Onboarding/
    AgeGate/
    SignUp/
    KYC/
  Authentication/
  RootCoordinator/
```

State, Action, and reducer per feature. Use TCA's `@Reducer` and `@ObservableState` macros.

### 16.4 — Networking

`DankDashNetwork`:

- `swift-openapi-generator` produces typed client from `docs/spec/openapi.yaml`
- `APIClient` wraps generated client with: token refresh, retry policy, error mapping
- All calls return `Result<Response, APIError>` for explicit error handling
- Background-safe: requests can complete even when app is backgrounded

### 16.5 — Token storage

KeychainAccess wrapper in `DankDashCore`. Access token and refresh token stored separately, with biometric protection on refresh token.

### 16.6 — Auth screens

- Age gate (DOB picker, "I am 21+" toggle)
- Sign up (email, password, phone, name)
- Login
- KYC trigger (presents Persona iOS SDK)
- Forgot password

### 16.7 — Tests

- Snapshot tests on UI components (FB Snapshot Testing)
- TCA reducer tests for each feature
- KeychainAccess tests
- API client mocked tests

## Phase 16 — Definition of Done

- [ ] Xcode project builds for both targets
- [ ] Auth flow works against staging API
- [ ] Design system documented in a sample gallery view
- [ ] iOS tests pass via `xcodebuild test`
- [ ] CI runs iOS tests via macOS GitHub Actions runner or Xcode Cloud
- [ ] Branch pushed, PR opened

---

# PHASE 17 — iOS Consumer: Feed & Catalog

**Goal:** Dispensary feed, dispensary storefront, product detail, search.

## Tasks

### 17.1 — Dispensary feed

- Geolocation request on first launch (with rationale)
- Fetches `/v1/dispensaries?lat=&lng=`
- LazyVStack of `DispensaryCard` with frosted-glass overlay
- Pull-to-refresh
- Empty state when no dispensaries in delivery range
- Sections: "Delivering Now", "Top Rated", "New", "Closing Soon"

### 17.2 — Storefront

- Hero image, dispensary info, hours, rating
- Sticky category tab bar
- Product grid: 2 columns, strain-type indicator dot, THC %, price
- Filter sheet: strain type, price range, THC range, effects

### 17.3 — Product detail

- Image carousel
- Description, brand, strain type, terpene profile
- COA PDF link (opens in-app via `QuickLook`)
- "Add to cart" button
- Related products

### 17.4 — Search

- Debounced search field
- Results across all in-range dispensaries
- Facets: category, strain type, brand

### 17.5 — Tests

- Snapshot tests on cards and screens
- TCA reducer tests
- Geolocation permission flow
- Search debouncing

## Phase 17 — Definition of Done

- [ ] All browse screens functional
- [ ] Offline-tolerant (cached last response shown)
- [ ] Accessibility: VoiceOver works on all screens
- [ ] Tests pass
- [ ] Branch pushed, PR opened

---

# PHASE 18 — iOS Consumer: Cart, Checkout, Tracking

**Goal:** Cart, compliance preview, checkout-in-Safari handoff, live order tracking.

## Tasks

### 18.1 — Cart

- LineItems list with quantity steppers
- Compliance summary banner: "1.2/2.0 oz flower • 300/800mg edibles" with color-coded progress bars
- Empty cart state
- Cart expiry warning at 30min remaining

### 18.2 — Compliance preview

- Calls `/v1/carts/:id/validate` on every cart change
- Shows blocking error if cart fails (with specific rule failure)
- "Add" button on product disabled if it would push over limit

### 18.3 — Checkout flow (Apple workaround)

**Critical:** Checkout happens in `SFSafariViewController` against `checkout.dankdash.com`:

- Generate one-time auth token via `POST /v1/auth/checkout-handoff`
- Open Safari view with `https://checkout.dankdash.com?handoff=<token>`
- Web checkout-web app exchanges handoff token for session, completes checkout
- On completion, web redirects to `dankdash://order/complete?orderId=...`
- iOS app catches deep link, returns to native order tracking screen

### 18.4 — Order tracking

- Status timeline (Placed → Accepted → Prepping → ...)
- Live map (Mapbox) once driver assigned
- Driver card: name, photo, vehicle, masked phone (Twilio Proxy)
- Push notification on each status change
- ETA updated via Socket.io

### 18.5 — Order history

- List of past orders
- Detail view with reorder action
- Rating sheet appears 5min after delivery

### 18.6 — Tests

- TCA tests for cart logic
- Snapshot tests
- Deep link handling test

## Phase 18 — Definition of Done

- [ ] Cart with compliance preview working
- [ ] Safari handoff flow working end-to-end
- [ ] Live tracking with realtime updates
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 19 — iOS Driver: Foundation & Shift

**Goal:** Driver app onboarding flow, shift management, map home screen.

## Tasks

### 19.1 — Onboarding

- Welcome, document upload (license, insurance, registration)
- Veriff identity verification
- Background check status polling
- Vehicle details

### 19.2 — Shift screen

- Big Online/Offline toggle (top-right of map)
- Map (dark style) with current location
- Demand heatmap overlay when online
- Earnings summary at bottom

### 19.3 — Background location

- Request `Always` location authorization with rationale screen
- Background mode entitlement: location
- Significant-change updates when idle, standard updates when on active route
- Battery-aware: reduce frequency when battery <20%

### 19.4 — Tests

- Onboarding flow TCA tests
- Location authorization handling

## Phase 19 — Definition of Done

- [ ] Driver can complete onboarding
- [ ] Shift can be started and ended
- [ ] Heatmap renders
- [ ] Background location working
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 20 — iOS Driver: Offers, Navigation, ID Scan

**Goal:** Receive dispatch offers, navigate, scan ID at delivery.

## Tasks

### 20.1 — Offer card

- Slide-up sheet on offer arrival
- Payout estimate, pickup, dropoff, total miles
- 30s countdown ring
- Haptic ping
- Accept / Decline buttons

### 20.2 — Active route

- Turn-by-turn via MapKit (Apple Maps)
- Pickup screen: dispensary info, "Confirm Pickup" button
- Dropoff screen: customer info, "Arrived" button

### 20.3 — ID scan

- Veriff iOS SDK opens for ID + selfie scan
- Result returned to app
- On pass: "Delivery Complete" button
- On fail: re-scan, contact support, or return to store

### 20.4 — Earnings wallet

- Today, this week, all-time
- Tip breakdown
- Aeropay cashout button

### 20.5 — Tests

- Offer flow TCA tests
- ID scan integration (sandbox Veriff)
- Earnings calculation

## Phase 20 — Definition of Done

- [ ] End-to-end delivery flow works
- [ ] ID scan blocks completion until pass
- [ ] Earnings accurate
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 21 — Hardening: Security, Observability, Load Test

**Goal:** Security audit pass, observability complete, load test against staging.

## Tasks

### 21.1 — Security audit

- Run `npm audit`, `snyk test`, `semgrep` — fix all high/critical
- OWASP ZAP scan against staging API — fix findings
- Review every endpoint's authorization
- Penetration test checklist (IDOR, SQLi, XSS, CSRF, SSRF, JWT tampering)
- Secrets scan with `gitleaks` over full git history

### 21.2 — Observability

- OpenTelemetry instrumentation on API, workers, realtime
- Export to Grafana Cloud
- Dashboards: request rate, p50/p95/p99 latency, error rate, queue depth, DB connection pool, Redis hit rate
- Alerts wired to PagerDuty per spec §8.4

### 21.3 — Load test

- k6 scripts:
  - 1000 customers browsing dispensary feed
  - 100 simultaneous checkouts
  - 30 drivers streaming location at 1Hz
  - Vendor portal receiving 100 orders/min via realtime
- Run against staging, identify bottlenecks, fix, re-run
- Target: API p95 <500ms under load

### 21.4 — Database hardening

- Run `EXPLAIN ANALYZE` on top 20 slowest queries from production logs
- Add indexes where needed
- Vacuum/analyze settings reviewed
- Connection pool sized correctly (pgbouncer if needed)

### 21.5 — Disaster recovery drill

- Restore prod backup to staging
- Verify integrity
- Document RTO/RPO actuals

## Phase 21 — Definition of Done

- [ ] Zero high/critical vulnerabilities
- [ ] All observability dashboards populated
- [ ] Load test passes target thresholds
- [ ] DR drill documented
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened

---

# PHASE 22 — Pre-launch: Admin Console, Runbooks, Docs

**Goal:** Internal admin tooling, operational runbooks, user-facing legal docs.

## Tasks

### 22.1 — Admin console

`apps/portal/src/app/admin/` (protected by `admin` or `superadmin` role):

- User management (search, suspend, reset KYC)
- Dispensary management (approve, suspend)
- Order lookup and force-state-transition (for support cases)
- Refund approval queue
- Compliance check failures dashboard
- Metrc reconciliation report
- Ledger viewer

### 22.2 — Runbooks

`docs/runbooks/` — one per scenario:

- Aeropay outage
- Metrc API failure
- High order error rate
- Database failover
- Driver app crash spike
- Customer complaint escalation
- License compliance audit response
- Data export request
- Account deletion request
- Password pepper rotation
- JWT key rotation

Each runbook: trigger, immediate actions, escalation, post-mortem template.

### 22.3 — Legal docs

`apps/portal/src/app/(legal)/`:

- Terms of Service
- Privacy Policy
- Vendor Agreement
- Driver Agreement
- Cannabis Compliance Disclosures

These should be reviewed by counsel before launch — placeholder content acceptable for now, with `[REVIEW WITH COUNSEL]` markers.

### 22.4 — Onboarding flows

- Vendor self-onboarding wizard (collects license info, sets up first product, connects POS)
- Driver self-onboarding wizard
- Both pause at admin-approval gates

### 22.5 — Launch checklist

`docs/LAUNCH-CHECKLIST.md`:

- Environment variables set in production
- Metrc credentials provisioned
- Aeropay production access enabled
- Apple App Store / Business Manager submissions
- DNS pointed correctly
- SSL certificates valid
- Monitoring dashboards reviewed
- On-call rotation defined
- Status page configured (BetterStack)
- Customer support email + Twilio number live
- First-week support staffing plan

## Phase 22 — Definition of Done

- [ ] Admin console functional
- [ ] All runbooks written
- [ ] Legal placeholder docs in place
- [ ] Self-onboarding flows working
- [ ] Launch checklist reviewed and signed off
- [ ] Final smoke test against production
- [ ] All green-light commands pass
- [ ] Branch pushed, PR opened
- [ ] **Ready to ship.**

---

# PHASE 23 — Final integration: production env validation + cutover

**Goal:** Close the gap between "Phase 22 docs exist" and "the CEO can walk the launch checklist top-to-bottom." Phase 22 left two operational gaps the checklist explicitly references: a production env-validation CLI (`pnpm --filter @dankdash/api run env-check`, called out in launch-checklist §2.3) and a production-shaped env template separate from the dev `.env.example`. Phase 23 ships both, plus the schema-level changes that let the launch-checklist §2.1 variables be enforced rather than aspirational. The integration-test suite the original ADR 0009 footnote referenced ("Phase 23 explicitly depends on the runbooks") is deferred to a follow-up — the integration tests that already exist under `apps/api/test/integration/` cover the order-lifecycle happy path against testcontainers, and the runbook-driven dry-runs are operational rehearsals (per launch-checklist §8 last bullet) rather than CI artifacts.

## Tasks

### 23.1 — Production env-check CLI

`apps/api/src/cli/env-check.ts` — a standalone CLI that loads `process.env`, runs the `EnvSchema` validator from `@dankdash/config`, and applies a stricter production-mode overlay when `NODE_ENV=production`:

- `NODE_ENV` must be exactly `production` (not `staging`, not `development`).
- `DATABASE_URL` / `REDIS_URL` must not be `localhost` / `127.0.0.1` / `::1`.
- `LOG_LEVEL` must not be `debug` or `trace` (defaults to `info`; `warn` / `error` allowed).
- `SENTRY_DSN` must be present.
- `OTEL_EXPORTER_OTLP_ENDPOINT` must be present.
- Feature-flag/credential coherence: if `ENABLE_AEROPAY=true`, then `AEROPAY_CLIENT_ID`/`AEROPAY_CLIENT_SECRET`/`AEROPAY_WEBHOOK_SECRET` must be non-empty and not `test_*` / `sandbox_*`; same for `ENABLE_METRC`/`METRC_*`, `ENABLE_PERSONA`/`PERSONA_*`, `ENABLE_VERIFF`/`VERIFF_*`. If `AEROPAY_LIVE=true`, the same Aeropay creds must be non-test.
- `AEROPAY_API_BASE_URL` / `METRC_API_BASE_URL` / `VERIFF_API_BASE_URL` must not be sandbox hostnames.
- JWT key material must decode to a valid PEM and the public key must match the private key — surface a clear error if the pair is mismatched (a common rotation foot-gun).

Exit code 0 on success; non-zero with a structured human-readable list of failures otherwise. Wired into `apps/api/package.json` as `"env-check": "tsx src/cli/env-check.ts"`.

The pure check functions live in `packages/config/src/env-check.ts` (so the test suite runs against vitest defaults — no testcontainers, no Docker, ~8ms). The CLI in `apps/api/src/cli/env-check.ts` is a thin shim that calls `loadEnv()` + `runAllChecks()` and translates the result into stdout/stderr + exit codes. `packages/config/src/env-check.test.ts` covers the dev-mode pass case, every production strict-mode failure, every feature-flag coherence case (matched / unmatched / sandbox-host base URL / test-credential prefix), the Twilio sender XOR (both-unset, both-set, exactly-one), and the JWT-pair check (matched, mismatched, invalid PEM, absent).

### 23.2 — `.env.production.example` template

A production-shaped env template at repo root, distinct from the dev `.env.example`. Every key the `EnvSchema` enforces is present with an empty placeholder; every key the launch-checklist §2.1 names but the schema does not yet enforce (e.g. `DATABASE_REPLICA_URL`, `STICKY_SESSION_KEY`, `BULLMQ_PREFIX`, `WEB_BASE_URL`) is present as a commented `# OPTIONAL` placeholder with a one-line note. The template documents where each value comes from (Railway secret manager, R2 dashboard, Aeropay portal, Apple Developer portal, etc.).

Gitignored siblings: `.env.production`, `.env.staging`, `.env.local` remain ignored. The `.env.production.example` is committed.

### 23.3 — Phase 20 typecheck sweep-fix + Phase 23 doc entries + ADR 0010

- **Sweep-fix.** Three pre-existing typecheck errors in `apps/api/src/modules/drivers/services/` from incomplete Phase 20 work surfaced when the final-integration sweep ran `pnpm --filter @dankdash/api typecheck`. Mechanical fixes: `driver-orders.service.ts:190` calls `OrderEventsRepository.listForOrder` (was `listTimelineForOrder` — wrong name); `driver-id-scan.service.test.ts:48` imports `OrderTransitionService` from `../../orders/order-transition.service.js` (was importing a non-existent `OrderEventsService`); both `makeOrder` test fixtures extended with the post-Phase-20 nullable `Order` columns (`paymentFailedAt`, `rejectedAt`, `preppingAt`, `awaitingDriverAt`, `dispatchFailedAt`, `driverAssignedAt`, `enRoutePickupAt`, `enRouteDropoffAt`, `arrivedAtDropoffAt`, `idScanPendingAt`, `returnedToStoreAt`, `disputedAt`, `ratedAt`) so the literals satisfy the Drizzle `$inferSelect` shape under `exactOptionalPropertyTypes`. The `FakeOrderEventsRepo` and `FakeOrderEventsService` test doubles renamed to match the corrected types. No behavioral changes; the integration tests that exercise these services were already green.
- **Doc entries.**
  - `docs/CLAUDE-CODE-PHASES.md` — this section.
  - `docs/adr/0010-phase23-final-integration.md` — scope decision, what shipped, what was deferred, why the integration-test suite is not in this phase.
  - `docs/LAUNCH-CHECKLIST.md` §2.1 + §2.3 — corrected `env.schema.ts` → `env.ts` references and described what the env-check CLI actually does.
  - `PROGRESS.md` — Phase 23 entry.

## Phase 23 — Definition of Done

- [x] `pnpm --filter @dankdash/api run env-check` exists; runs `loadEnv()` + `runAllChecks()` and exits 0/1/2.
- [x] Running `env-check` against a deliberately broken production env produces a clean, actionable failure list and exit code 2 (verified via the 27-test unit suite against synthetic envs).
- [x] `.env.production.example` committed at repo root and not gitignored.
- [x] ADR 0010 committed.
- [x] `PROGRESS.md` updated.
- [x] `pnpm --filter @dankdash/api typecheck` passes (sweep-fix lands the leftover Phase 20 regressions).
- [x] `pnpm --filter @dankdash/config typecheck` and `pnpm --filter @dankdash/config test` pass.
- [x] Branch pushed, PR opened.

---

# Cross-Phase Rules Recap

Before starting any phase, Claude Code:

1. Reads `CLAUDE.md`
2. Reads the relevant section of this document
3. Reads the four spec files in `docs/spec/`
4. Reviews `PROGRESS.md` for context from prior phases
5. Creates branch `phase/NN-<name>`
6. Works through tasks in order
7. Runs the green-light commands
8. Commits, pushes, opens PR
9. Updates `PROGRESS.md` with summary
10. Stops and waits for the user

If a phase grows beyond ~3 hours of work or hits a blocker, **stop and write `BLOCKED.md`** — do not push through with shortcuts.

**The goal is not speed. The goal is shippable code that a regulated business can stake its license on.**
