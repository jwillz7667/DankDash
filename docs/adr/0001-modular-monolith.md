# ADR 0001 — Modular monolith over microservices

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

DankDash launches with three clients (consumer iOS, vendor portal, driver iOS) talking to one backend that must orchestrate compliance, ordering, dispatch, payments, identity verification, and Metrc traceability for the Minnesota adult-use cannabis market. The business has hard regulatory deadlines (MN Stat. § 342.27 reporting, Metrc reconciliation windows) and a small engineering team. We need:

- A single transactional boundary covering cart validation, compliance evaluation, inventory reservation, payment authorization, and order creation. Splitting these across services would force distributed-transaction patterns (sagas, outbox + compensations) that we cannot afford to design correctly in the v1 timeline.
- Strong module boundaries so that the compliance, payments, and Metrc surfaces can be reasoned about in isolation and reviewed by domain experts.
- Operational simplicity — one app to deploy, one Postgres to backup, one set of secrets to rotate. The team is one to three engineers at launch.
- Optionality to extract specific modules later if scale or team size demands it.

Microservices were considered and rejected: the transactional coupling between compliance / inventory / payments / orders is high, and the synchronous network hops would add latency that pushes us past the 250 ms p95 read budget set in the global standards. Operational overhead (per-service CI, per-service observability, schema migration coordination) is also a poor fit for a small team.

## Decision

The backend is a **modular monolith** deployed as three Railway services that share a single codebase:

1. `apps/api` — NestJS on Fastify adapter. Contains every business module. Each module owns its tables, exposes a repository interface to peers, and never reaches across domain boundaries with raw SQL joins.
2. `apps/realtime` — A Socket.io server, separate process for sticky-session reasons (Railway TCP proxy). Reads the same Postgres + Redis; pushes order/dispatch events to clients.
3. `apps/workers` — A BullMQ runner for background jobs (Metrc reconciliation, payout batching, notification fan-out, COA ingestion). Same codebase, different entrypoint.

NestJS modules are the unit of isolation. Cross-module communication is through TypeScript interfaces defined in `packages/types`, never through HTTP. The shared `packages/db` exposes a typed Drizzle client; per-module repositories live with each module.

## Consequences

**Positive**

- One transaction can span compliance + inventory + orders + payment intent creation — the existential path for a cannabis sale.
- One deploy per change, one rollback per incident. CI is simpler. Local dev is `pnpm dev` plus `docker compose up`.
- Module boundaries are enforced by ESLint `no-restricted-imports` rules (added in later phases) — violations are caught at lint time, not runtime.
- Optionality preserved: any module can be extracted into its own service later by repointing its repository interface at an HTTP client, because consumers already depend on the interface rather than the implementation.

**Negative**

- A runaway change in one module can degrade the whole API. Mitigated by per-module ownership, per-module test suites, and the compliance gate in CI.
- We cannot independently scale, deploy, or roll back modules. Acceptable given launch-stage traffic; revisit at >100 req/s sustained.
- A single Postgres is a shared blast radius. Mitigated by RLS on tenant-touchable tables and per-row constraints encoded in CHECK / triggers.

**Neutral**

- The realtime and workers processes still need their own deployment configs; they are not "free" relative to a single API process.

## Revisit triggers

- Team size > 8 engineers.
- Sustained API traffic > 100 req/s OR Metrc reconciliation latency forces queue isolation.
- A second market (e.g. NY, CA) requires a different compliance engine — the compliance module becomes a candidate for extraction.
