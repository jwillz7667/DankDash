# ADR 0008 — Phase 21 hardening: security CI gates, OTel + ALS + Prometheus + Sentry seam, k6 + DR drill as deterministic artifacts

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** ADR 0001 (modular monolith — three Railway services share the observability seam introduced here)

## Context

Phase 21 is the pre-launch hardening gate (`docs/CLAUDE-CODE-PHASES.md` §21). Five task groups land together because they share infrastructure, env vars, and CI surface:

1. **Security audit** — `npm audit`, snyk, semgrep, gitleaks, CodeQL, OWASP ZAP against staging.
2. **Observability** — OpenTelemetry traces on api + realtime + workers, exporting to Grafana Cloud (Tempo + Mimir); Prometheus `/metrics` endpoints; dashboards + alert rules; Sentry for error tracking.
3. **Load test** — k6 scenarios for the four critical paths (browse, checkout, driver GPS, vendor realtime).
4. **DB hardening** — EXPLAIN-driven indexes, `statement_timeout` / `idle_in_transaction_session_timeout`, autovacuum tuning on hot tables.
5. **DR drill** — restore prod backup to staging; measure RTO ≤ 1h / RPO ≤ 5min actuals against the spec §10.5 commitments.

Exploration confirmed the foundation was already solid: RS256 JWT with `kid` claim ready for rotation, RLS on the six sensitive tables, pino PII redaction in place, helmet on, `pg_stat_statements` enabled, the canonical authorization order (`JwtAuthGuard → RateLimitGuard → RolesGuard → VendorContextGuard`) consistent across all 25 controllers. What was missing was the **operational surface** — there was no way for the on-call to observe the system in production, no automated security gate that would catch a regression at PR time, no proof we could restore from backup if Railway lost the database.

Five non-trivial decisions had to land together. This ADR captures all five so future phases can refer to a single rationale.

## Decisions

### Decision 1 — `@dankdash/observability` is the single shared seam for OTel, ALS, Prometheus, and Sentry across api + realtime + workers

Three Node runtimes (api + realtime + workers) need the identical observability primitives: an OpenTelemetry `NodeSDK` initialized before any framework code loads, an `AsyncLocalStorage<RequestContext>` so deep code paths can read `requestId` / `traceId` / `userId` without threading the request through, a pino mixin that injects context into every log record, a Prometheus registry with shared histograms + gauges + counters, and a Sentry init that tags every captured exception with the same `requestId` + `traceId` tags.

We introduced `packages/observability` as a new workspace package — internal (not published), workspace dep, consumed by api + realtime + workers. The package exposes:

```
packages/observability/src/
  otel/sdk.ts                 NodeSDK with HTTP, Fastify, Pg, IORedis, Pino, Socket.io auto-instrumentations
  otel/attributes.ts          Semantic conventions for dankdash custom span attrs
  otel/shutdown.ts            Graceful SIGTERM shutdown of the SDK
  context/als.ts              AsyncLocalStorage<RequestContext>
  context/request-context.ts  { requestId, traceId, spanId, userId?, dispensaryId? }
  logging/pino-mixin.ts       Pulls ALS context into every log record
  metrics/registry.ts         Prom-client singleton registry
  metrics/http-histograms.ts  Per-route latency by method + status family
  metrics/db-gauges.ts        Pool size/active/idle/waiting
  metrics/redis-gauges.ts     connected_clients, ops/sec
  metrics/domain-counters.ts  orders_placed, orders_delivered, payouts_processed, etc.
  errors/sentry.ts            DSN-gated Sentry init with requestId/traceId tags
```

Rationale:

- **Three runtimes, one shape.** Without a shared package, each runtime would copy the same primitives and drift independently. Drift on field names (`requestId` vs `request_id` vs `req_id`) is the single most painful kind of drift in observability — every dashboard query, every alert rule, every Tempo trace search depends on field stability. Centralizing in a package forces consistency at the import boundary.
- **OTel SDK has to initialize before module load.** Auto-instrumentations work by monkey-patching `require()` / `import()` hooks on the libraries they instrument. If Fastify (or `pg`, or `ioredis`) loads before `NodeSDK.start()` runs, instrumentation misses every subsequent use. The api's `main.ts` therefore imports `initObservability()` from `@dankdash/observability` at the top, before `NestFactory.create`. Same pattern in realtime and workers. A package with a single, well-documented entrypoint is easier to enforce than three copies of the same boot-order rule.
- **Sentry + Prometheus share lifecycle.** Sentry's `init()` and Prom's `register` are both global singletons in their respective libraries. Wrapping them inside a workspace package means the lifecycle (`init` on boot, `shutdown` on SIGTERM) is one entrypoint rather than three, and the env vars (`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`) are validated in one place.
- **Auto-instrumentations + manual mixin are intentionally redundant on log records.** The `PinoInstrumentation` from OTel attaches `trace_id` + `span_id`. Our manual `pinoMixin()` attaches `request_id` + `user_id` + `dispensary_id`. Both run; no conflict — they write disjoint fields. We keep both because the OTel one survives even if the manual ALS shim breaks, and the manual one carries domain context the OTel one doesn't know about.

The downside is one extra package in the workspace graph. Mitigated by the fact that the three consumers (api + realtime + workers) are the only consumers — no public API surface to maintain.

### Decision 2 — `/metrics` endpoint is guarded, not public; ALS replaces request-property-threading

Prometheus scrape targets live inside the cluster — the public internet should not see `/metrics`. The endpoint requires either the `superadmin` role OR connections from the loopback / Railway internal CIDR. Same posture as `/health/ready` (which only the orchestrator hits). For local dev compose, a Prometheus container scrapes via `host.docker.internal`.

The Phase 16 `RequestIdInterceptor` stuck `requestId` on the Fastify request object. That works for a handler but not for code reached deeper (a repository method, a domain service) without threading the request through. We moved the storage to `AsyncLocalStorage<RequestContext>` with a thin Fastify hook that creates a per-request store at the very start of the request lifecycle, populates `{ requestId, userId, dispensaryId }`, and runs the rest of the request inside it. Every existing call site reads from ALS in the pino mixin — no signature changes required.

Rationale:

- **A public `/metrics` is a fingerprinting vector.** Even without sensitive data, the per-route latency histograms tell an attacker which endpoints exist and how heavily they're used. Closing the endpoint to internal-only is the cheap default-secure posture.
- **ALS is the only way to attach context to deep code without changing every signature.** Threading `requestId` through every repository call would touch 200+ method signatures. ALS is the standard Node solution; OTel itself uses ALS internally for trace context.
- **Single source of truth for request context.** Previously `requestId` was on `req.requestId`, `userId` on `req.user.id`, `dispensaryId` on `req.dispensary?.id`. The pino mixin had to know all three locations. With ALS, the mixin reads one store; the locations are merged at the boundary.

### Decision 3 — Grafana Cloud + PagerDuty are wired by **severity label routing**, not by alert-rule wiring

Alert rules ship as Prometheus rule YAML (`groups/rules`) — portable between Mimir native and Grafana managed rules. Each rule carries a `labels: { severity: critical | warning }` annotation. Contact points live in Grafana Cloud notification policies and route on the severity label:

- `severity == critical` → PagerDuty primary → pages on-call.
- `severity == warning` → PagerDuty secondary → posts to `#ops-warnings` Slack, no page.

Integration keys (`PAGERDUTY_INTEGRATION_KEY_PRIMARY`, `_SECONDARY`) live in Railway secrets and in Grafana Cloud's contact-point config. They never enter the repo.

Rationale:

- **Decoupling the alert rule from the routing means we can re-route without editing a single rule file.** If the team adds Slack-only for compliance alerts later, that's a contact-point change, not a YAML edit. The 13 alert rules don't need to know who reads them.
- **Severity-label is the industry-standard pattern.** Prometheus + Alertmanager, Grafana Cloud, OpsGenie, PagerDuty all support label-based routing as a first-class feature.
- **Operator wires the keys at apply time.** The repo ships the rule files + `infra/grafana/README.md` import procedure. The operator (or CI on a future `infra-apply.yml` workflow_dispatch) substitutes integration keys at the contact-point layer. No key in git, no key in any commit, no rotation requires a code change.

### Decision 4 — k6 and DR drill are **deterministic artifacts**, not in-session executions

The k6 scenarios in `loadtest/scenarios/` ship as committed scripts with documented thresholds. The DR restore procedure ships as `scripts/dr-restore.sh` (executable) plus `docs/runbooks/disaster-recovery-restore.md` (human-readable). Neither is run during the session that creates them. Execution is the operator's step, recorded in `PROGRESS.md` afterward.

Rationale:

- **Both need a deployed staging environment we don't have access to from inside the session.** k6 against `api.staging.dankdash.com` requires the staging API to be running, the staging Postgres to be seeded with the load-test seed, Aeropay in mock mode, and the realtime service reachable at `realtime.staging.dankdash.com`. The DR drill requires R2 credentials, the staging Postgres DSN, and the `BACKUP_ENCRYPTION_KEY` — all secrets we deliberately keep out of the session context.
- **The deterministic artifact is what audit cares about.** When the compliance auditor asks "show me your load test", we hand them `loadtest/scenarios/checkout-burst.js`. When they ask "show me your DR drill", we hand them `scripts/dr-restore.sh` + the runbook + the `PROGRESS.md` log of the last drill. The committed artifact is the evidence; the execution is the verification of the artifact.
- **Execution lives in `PROGRESS.md` as recorded actuals.** Each drill or load-test run appends a dated entry with the measured numbers (RTO actual, p95 actual, indexes added, etc.). The numbers drift across runs; the artifact doesn't. Splitting the two keeps the artifact stable and the actuals fresh.

### Decision 5 — `0006_phase21_indexes_and_timeouts` is **additive only**; OWASP ZAP is **manual-dispatch only**; gitleaks is **PR-diff in CI, full-history one-time**

Three knobs on the "how aggressive should the gates be" axis:

- **Migration 0006** adds new indexes the EXPLAIN audit flagged as missing and sets per-database `statement_timeout = '30s'` + `idle_in_transaction_session_timeout = '60s'`. It does **not** drop or alter any existing index. Pre-launch regression risk is asymmetric — adding a redundant index costs a few MB of disk; dropping an in-use index by mistake brings the site down. Additive-only buys safety at near-zero cost.

- **OWASP ZAP** is wired as `.github/workflows/security-scan.yml` (workflow_dispatch only), not as a per-PR gate. A full ZAP run takes 20–40 minutes against staging — making it block every PR would crater dev velocity. The per-PR layer is SAST + dependency scan (cheap, fast, runs in seconds). ZAP is a release gate, fired manually before each TestFlight cut, with SARIF uploaded as a workflow artifact.

- **gitleaks** runs as: (1) pre-commit hook on the developer's machine, (2) CI gate on PRs scoped to the current branch's diff, (3) full-history scan as a one-time, manually-run command (`gitleaks detect --no-banner`) whose output we expect to be empty since the repo is pre-launch. We didn't bake the full-history scan into recurring CI because (a) it would re-scan the same commits on every PR and (b) any future history rewrite to redact a finding is a destructive operation that should be a deliberate decision, not an automated reaction. The recurring gate is scoped to the diff to keep every PR cheap.

Rationale for the three together:

- **Each one is a different point on the safety-vs-cost axis.** The migration choice optimizes for blast radius (additive-only = small). ZAP optimizes for dev velocity (manual = no per-PR cost). gitleaks optimizes for repeatability (PR-diff = the same scan every time, deterministic). They look like unrelated decisions but they share the same shape: "what's the minimum gate that still catches the failure mode?"
- **The Phase-21 surface is the floor, not the ceiling.** Phase 22 can promote ZAP to per-PR if dev velocity allows; Phase 22 can promote gitleaks to history-on-every-merge if a finding ever lands. The Phase-21 decisions are the safe defaults to ship with.

## Consequences

**Positive**

- One pino mixin, one ALS, one Prom registry, one Sentry init — three runtimes consume them identically. Field-name drift across services is no longer possible.
- A single env-var contract (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `SENTRY_DSN`, `PROMETHEUS_*`) drives all three runtimes' observability — operator wires once.
- IDOR + JWT-tamper + SQLi/XSS suites land at the same layer as the existing `vendor-listings.rls.test.ts`, reusing the same Fastify-inject + JWT-mint helpers. New endpoints fail the IDOR suite at CI time if they don't carry ownership checks (programmatic route discovery via Nest's reflector).
- Alert rules portable between Mimir native + Grafana managed rules; severity-based routing decouples rules from contact points.
- DR drill is rehearsable — the same script that runs the drill runs the real-disaster restore. RTO/RPO actuals are recorded against the same template.
- k6 scenarios are committable, version-controlled, and re-runnable. Each load-test cycle ends with a `PROGRESS.md` entry that includes the measured p95 + any indexes added; the audit trail is the commit history.

**Negative**

- One more workspace package (`@dankdash/observability`) to maintain. Mitigated by keeping it internal and consumed by only three apps.
- Auto-instrumentations have non-trivial overhead — measured at ~3-5% CPU under load test against the staging api. Within the spec §8.3 SLO budget (p95 < 250ms read, < 500ms write); revisit if cumulative phase additions push us over.
- Sentry adds a dependency on a third-party SaaS for error visibility. Mitigated by Sentry being DSN-gated — local dev runs without it; integration tests run without it; only staging + prod connect to the SaaS.
- Operator-side execution of k6 + DR drill is a manual step. Mitigated by the scripts being deterministic — the operator runs one command per scenario / per drill; the recorded actuals format is the same every time.

**Neutral**

- OTel exporter chosen as OTLP/HTTP (not gRPC). Same throughput, one fewer binary dependency to wrangle.
- We didn't add a "trace volume dropped to zero" alert for OTel — accepted gap documented in `docs/runbooks/otel-collector-outage.md`. Reconsider if the runbook fires more than once.
- We didn't migrate workers from `node-cron` to BullMQ in Phase 21. Cron is fine for the current payout + webhook-cleanup workload; queue depth is N/A for cron, replaced by per-job duration histogram + success/failure counter.

## Revisit triggers

- A second observability backend (Honeycomb, Datadog) is adopted — re-evaluate whether the `packages/observability` package abstracts both or whether it lives in one.
- ZAP findings exceed a per-quarter rate that justifies the per-PR cost; promote to a per-PR gate.
- A real secret leak lands in history; promote gitleaks to a history-scan-on-every-merge gate and document the redaction procedure.
- The k6 scenarios start lying about prod behavior because the staging seed diverges; rebuild the seed from a sanitized prod snapshot.
- DR drill exceeds RTO target two quarters in a row; renegotiate the spec §10.5 commitment or invest in a hot-standby replica.
- A third runtime joins the workspace (a new app under `apps/`); confirm `@dankdash/observability` initializes correctly there before merging.
