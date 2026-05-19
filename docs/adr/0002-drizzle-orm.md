# ADR 0002 — Drizzle ORM over Prisma

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

The schema (`docs/spec/schema.sql`) is Postgres-specific and leans heavily on features that ORMs handle unevenly:

- **PostGIS** for delivery polygons, geofence containment (`ST_Contains`), and dispensary service-area queries.
- **Row-level security** on `orders`, `order_items`, `cart_items`, `dispensary_listings`, `payouts`, `payment_transactions`. Per-request `SET LOCAL app.current_dispensary_id` drives RLS predicates.
- **Generated columns**, partial indexes, `CHECK` constraints with business semantics (e.g. beverage THC per-serving), and append-only triggers on `order_events`.
- **Table partitioning** on `order_events` and `notification_deliveries` (by month) and on `audit_log` (by quarter).
- **pgcrypto** envelope encryption for `restricted` columns; the application supplies the column key wrapped by a master key in Railway secret manager.
- **UUIDv7** primary keys generated in the app layer; `gen_random_uuid()` is the database fallback only.

We evaluated Prisma and Drizzle in detail.

- **Prisma** would not model PostGIS columns natively — every spatial query would drop into `prisma.$queryRaw` or `Prisma.sql`. Prisma migrations would still need hand-written SQL for partitioning, RLS policies, generated columns, and `CREATE TRIGGER`. The migration files Prisma _does_ produce are not the file we would commit — we would maintain a parallel SQL track. RLS in particular has no first-class Prisma story: setting `app.current_dispensary_id` per request requires escaping to `$transaction([$executeRaw(SET LOCAL ...), …])`, which is awkward and easy to forget.
- **Drizzle** treats Postgres as the substrate. Migrations are plain reviewable SQL files generated from a typed schema (`drizzle-kit generate`), and we can hand-author any `CREATE POLICY` / `CREATE TRIGGER` / partition statement directly into the migration file. Spatial columns are declared as custom column types (`geometry('Point', 4326)`); the query builder lets us write `sql\`ST_Contains(...)\``ergonomically inline, with parameter safety. Transaction-scoped session variables for RLS are a one-liner:`tx.execute(sql\`SET LOCAL app.current_dispensary_id = ${id}\`)`.

The cost of Drizzle is no built-in equivalent to Prisma Studio and a smaller ecosystem of community helpers. We accept both.

## Decision

`packages/db` is built on **Drizzle ORM** with the `postgres` driver.

- Schema files live under `packages/db/src/schema/<module>.ts`, one file per business module, re-exported from `packages/db/src/schema/index.ts`.
- Generated migrations live under `packages/db/src/migrations/` and are committed. Hand-edited migrations are permitted and expected for RLS policies, triggers, partition setup, and PostGIS-specific operations.
- Repositories sit beside each module under `apps/api/src/<module>/<module>.repository.ts`. They take a typed Drizzle client (or transaction) by dependency injection and never expose the raw client to upstream layers.
- All money columns are `numeric(12, 2)` in the schema and `integer` cents in the TypeScript domain. Conversion happens in the repository layer, never in services. Cannabis weights use `numeric(10, 4)` in the schema and `decimal.js` in code.
- UUIDv7 IDs are generated in the application layer (using `uuidv7` from npm), passed into the insert. Migrations declare `gen_random_uuid()` defaults only as a fallback.

## Consequences

**Positive**

- Migration SQL is reviewable in PR diffs and grep-able when an auditor asks "where did this constraint come from."
- PostGIS, RLS, partitioning, and triggers all live in one place (the migration files) rather than split between a schema language and a sidecar SQL track.
- Repositories return typed rows; services do not stringly-type their inputs.
- No N+1 footguns from lazy relation loading — Drizzle requires explicit joins, which forces query authors to think about indexes.

**Negative**

- No equivalent of Prisma Studio. Mitigated by `psql`, `\dt`, and (for non-engineers) Metabase pointed at the read replica in later phases.
- The query builder is more verbose than Prisma's relation API. Acceptable trade for transparency.
- Drizzle's ecosystem of community helpers (auth adapters, etc.) is smaller. We are not relying on any of them; auth is hand-rolled per spec § 7.

**Neutral**

- Test setup uses Testcontainers + `pnpm --filter @dankdash/db migrate` against a disposable schema, which would have looked similar with either tool.

## Revisit triggers

- Drizzle drops support for a Postgres feature we depend on (very unlikely).
- We add a second SQL engine to the stack and want a single ORM that abstracts both (unlikely — Postgres is the target).
