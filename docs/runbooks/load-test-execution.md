# Load test execution

## Purpose

This runbook is the procedure for executing the k6 load test
suite in `loadtest/` against the staging environment, interpreting
the results, and tuning the system until the spec §8.3 SLO
targets are met.

The plan in `loadtest/README.md` is the scenario index. This
runbook is the _execution_ counterpart — how to actually drive
the runs, what failure looks like, and how to record actuals in
`PROGRESS.md`.

## When to run

- **Before any TestFlight cut.** The load test gates the consumer
  iOS app's submission per spec §10.4.
- **After any migration touching hot tables.** Migrations on
  `orders`, `order_events`, `cart_items`, `dispensary_listings`
  can change query plans; the load test catches plan regressions.
- **After any change to the realtime broadcast topology.** Adding
  / removing emit calls in `apps/api/src/modules/` or the realtime
  adapter changes the WebSocket traffic shape.
- **Quarterly cadence.** Capacity drifts; the quarterly run keeps
  the SLO numbers honest.

## Pre-flight

### Staging environment

```bash
# 1. Confirm staging is up
curl -fsS https://api.staging.dankdash.com/health/ready | jq .
# expect: { "ok": true, "checks": { "postgres": "ok", "redis": "ok" } }

# 2. Confirm staging has the load-test seed applied
pnpm --filter @dankdash/db seed:loadtest -- --target=staging
# (loads 20 dispensaries × 500 listings, 2000 customers, 50 drivers)

# 3. Confirm Aeropay is in mock mode on staging
gh secret list -e staging | grep AEROPAY_TEST_MODE
# expect: AEROPAY_TEST_MODE=mock (last updated <recent>)
```

If `AEROPAY_TEST_MODE` is not `mock`, the checkout scenario will
hit the Aeropay sandbox rate limiter (~50 charges/min) and the
threshold will fail on `http_req_failed > 1%` from 429s, not
from any real latency issue. Don't bother running the test until
this is set.

### Local k6

```bash
# install (one-time)
brew install k6        # macOS
# or
curl https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz \
  -L | tar xz --strip-components=1 -C /usr/local/bin k6-v0.55.0-linux-amd64/k6

# verify
k6 version
```

### GitHub workflow (preferred for shareable runs)

```bash
gh workflow run load-test.yml \
  -f target=staging \
  -f scenario=checkout-burst \
  -f duration_s=300
```

Watch the run:

```bash
gh run watch
```

The workflow uploads the `k6-summary.json` artifact when done.

## Scenarios

### 1. browse-dispensary

```bash
# Local
API_BASE_URL=https://api.staging.dankdash.com \
  k6 run loadtest/scenarios/browse-dispensary.js

# Workflow
gh workflow run load-test.yml -f scenario=browse-dispensary
```

**Targets**: 1000 VUs ramping over 60s, holding 5 minutes.
**Threshold**: `http_req_duration p(95) < 500ms` for catalog reads.
**What it stresses**: read-replica routing (currently single
primary), dispensary listing index efficiency, Redis cache hit
ratio.

**Failure → next step**:

- `http_req_failed > 1%` → check api logs for 5xx; the failure
  is usually a Redis timeout (cache miss storm).
- `http_req_duration p(95) > 500ms` → check db-pool dashboard;
  if pool is saturated, the cache isn't holding warm; if pool is
  fine, the catalog SQL plan changed. EXPLAIN the dominant query
  from pg_stat_statements.

### 2. checkout-burst

```bash
API_BASE_URL=https://api.staging.dankdash.com \
  k6 run loadtest/scenarios/checkout-burst.js
```

**Targets**: 100 constant VUs for 5 minutes. Each iteration:
clear cart → add item → validate → checkout.
**Threshold**: `http_req_duration{name:checkout} p(95) < 1500ms`.
**What it stresses**: the canonical write path — cart insert +
compliance evaluation + order creation + ledger write, all in one
transaction.

**Failure → next step**:

- `cart.validate p(95) > 1000ms` → compliance package is slow;
  profile the validation pipeline (likely a missing index on
  cart_items or dispensary_listings).
- `checkout p(95) > 1500ms` → the order-creation transaction is
  too long. Open the trace for the slowest call; look for serial
  awaits that could be parallelized.
- `iteration_duration p(99) > 2500ms` → cumulative latency
  across the three calls; check for cold-start effects (first 30s
  always elevated as VUs spin up).

### 3. driver-gps

```bash
API_BASE_URL=https://api.staging.dankdash.com \
  k6 run loadtest/scenarios/driver-gps.js
```

**Targets**: 30 constant VUs, 1 POST/sec each, 5 minutes.
**Threshold**: `http_req_duration{name:locations.post} p(95) < 250ms`.
**What it stresses**: high-volume small-payload write path; the
driver_locations write index + the realtime broadcast trigger.

**Failure → next step**:

- `p(95) > 250ms` → the broadcast layer is back-pressuring writes.
  Check the realtime dashboard's "emit rate by event" panel — if
  `driver.location_updated` is the dominant emit, the Socket.io
  fanout is the bottleneck. Consider batching at the realtime
  bridge.

### 4. vendor-realtime

```bash
API_BASE_URL=https://api.staging.dankdash.com \
REALTIME_URL=https://realtime.staging.dankdash.com \
  k6 run loadtest/scenarios/vendor-realtime.js
```

**Targets**: 1 portal WS consumer + 100 orders/min producer,
5 minutes.
**Threshold**: `emit_latency_ms p(95) < 250ms`.
**What it stresses**: API → realtime → consumer emit chain; the
Redis pub/sub adapter; the engine.io WS framing.

**Failure → next step**:

- `emit_latency_ms p(95) > 250ms` → the api's commit-then-emit
  pattern has stalled somewhere. Open the trace for a slow emit
  in Tempo; look for a long DB commit before the emit fires.
- `socketio_events_received_total = 0` → the consumer didn't
  receive any events. Usually a namespace auth issue; check the
  realtime auth middleware for a token-shape change.

## Tuning loop

When a scenario fails, the path is:

1. Read the k6 JSON summary to find the failing threshold.
2. Open the Grafana dashboard for the relevant subsystem during
   the run window — the dashboards refresh every 30s so the
   shape during the test is preserved.
3. Click the histogram exemplar into Tempo → find the slowest
   trace span.
4. Add the index / parallelize the await / fix the cache key.
5. Deploy to staging.
6. Re-run the scenario.

Each iteration is 10-15 minutes (run + analyze + ship). Budget
two hours for first-time tuning.

## Recording actuals

After the suite passes, append to `PROGRESS.md`:

```markdown
### Load test — YYYY-MM-DD

- Target: staging (api.staging.dankdash.com)
- Seed: 20 dispensaries × 500 listings, 2000 customers, 50 drivers
- Scenarios:
  - browse-dispensary: p95 catalog read = <X>ms ✅
  - checkout-burst: p95 checkout = <X>ms ✅
  - driver-gps: p95 location = <X>ms ✅
  - vendor-realtime: p95 emit = <X>ms ✅
- Tuning required: <list of indexes added / config changes>
- Notes: <anything that surprised you>
```

The numbers feed the SLO dashboard's "last load-test" annotation
panel — keep them honest.

## Appendix A — How the seed differs from dev

The dev seed (`packages/db/src/seed.ts`) produces a tiny dataset
for fast feedback during development. The load-test seed
(`packages/db/scripts/seed-loadtest.ts`, Phase 21) produces a
realistic catalog:

- 20 dispensaries (vs 2 in dev) — across all MN regions, each
  with a delivery polygon covering ~5 sq miles.
- 500 listings per dispensary (10,000 total) — distributed
  realistically across flower / edible / concentrate / beverage.
- 2000 customers — with delivery addresses inside dispensary
  polygons.
- 50 drivers — onboarded + currently active.
- 0 orders — load tests place their own.

The seed namespace differs (`dankdash-seed-loadtest-v1` vs
`dankdash-seed-v1`), so UUIDs do not collide with dev data even
if both seeds run against the same DB.

## Appendix B — EXPLAIN audit log

Each iteration of the load test that produced an index change is
recorded here. The expected pattern: regression discovered →
EXPLAIN before → index added → EXPLAIN after → re-run passes.

### B.1 — 2026-MM-DD: <regression name>

(template — fill in when the first staging run discovers something)

```text
Query:

EXPLAIN (ANALYZE, BUFFERS):
  -- before:
  Seq Scan on order_events  (cost=... rows=...) (actual time=2400.123..2412.456)
  -- after (with index `order_events_driver_status_placed_idx`):
  Index Scan using order_events_driver_status_placed_idx on order_events
    (cost=... rows=...) (actual time=2.341..2.789)

Reduction: 99.9% wall time.
Index added in: packages/db/src/migrations/00XX_<name>.sql
```
