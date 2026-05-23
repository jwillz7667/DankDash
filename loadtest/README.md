# DankDash load tests (k6)

Phase 21 — pre-launch load harness. These scripts exist so the
operator can hammer the staging environment until the API holds its
p95 budget under the spec §8.3 traffic profile.

The scripts ship deterministically; the actual "run against staging
and tune until thresholds are green" pass is recorded in `PROGRESS.md`
once executed.

---

## Scenarios

| Script                           | Profile                                                  | Spec target                         |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| `scenarios/browse-dispensary.js` | 1000 VUs, 10 min, paginate menus + view detail pages     | p95 < 500 ms read endpoints         |
| `scenarios/checkout-burst.js`    | 100 simultaneous checkouts against one dispensary, 5 min | p95 < 1500 ms (writes + compliance) |
| `scenarios/driver-gps.js`        | 30 drivers POST location @ 1Hz for 5 min                 | sustained 1Hz with no shed          |
| `scenarios/vendor-realtime.js`   | 1 portal WebSocket consumer, 100 orders/min producer     | < 250 ms end-to-end emit            |

Spec §8.3 baselines come from `DankDash-Technical-Spec.md`.

---

## Prerequisites

```bash
# macOS
brew install k6

# Ubuntu
sudo gpg -k && \
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && \
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list && \
sudo apt-get update && sudo apt-get install k6
```

Staging must be seeded with the load-test seed before running. From
the repo root:

```bash
DATABASE_URL=$STAGING_DATABASE_URL \
  pnpm --filter @dankdash/db seed
```

The seed is deterministic (UUID v5 over `dankdash-seed-v1`) — every k6
script reads the same ID set via `lib/seed-ids.js`.

---

## Environment variables

| Variable            | Default                 | Purpose                                          |
| ------------------- | ----------------------- | ------------------------------------------------ |
| `API_BASE_URL`      | `http://localhost:3000` | Public API target (Railway staging URL in CI)    |
| `REALTIME_URL`      | `http://localhost:3001` | Socket.io target                                 |
| `LOADTEST_PASSWORD` | `Loadtest!23`           | Seeded consumer/driver password (override in CI) |
| `K6_OUT`            | `json=reports/run.json` | Output sink — JSON for downstream analysis       |
| `RAMPUP_S`          | `60`                    | How long to ramp up VUs                          |
| `DURATION_S`        | `300`                   | Main hold time per scenario                      |

`LOADTEST_PASSWORD` must match whatever `packages/db/src/seed.ts`
hashed for the load-test users. The dev seed currently uses
`set-portal-password.ts` to flip the sentinel hash to a known value —
the same helper runs against staging before the load-test seed.

---

## Running locally

Spin the API + realtime + workers stack:

```bash
docker compose up -d
pnpm --filter @dankdash/api dev &
pnpm --filter @dankdash/realtime dev &
```

Then point k6 at it:

```bash
cd loadtest
k6 run scenarios/browse-dispensary.js
k6 run scenarios/checkout-burst.js
k6 run scenarios/driver-gps.js
k6 run scenarios/vendor-realtime.js
```

Each script emits a JSON report under `loadtest/reports/`. The folder
is gitignored.

---

## Running against staging

```bash
API_BASE_URL=https://api.staging.dankdash.com \
REALTIME_URL=https://realtime.staging.dankdash.com \
LOADTEST_PASSWORD="$STAGING_LOADTEST_PASSWORD" \
  k6 run --vus 1000 --duration 10m scenarios/browse-dispensary.js
```

Or use the CI workflow:

```bash
gh workflow run load-test.yml \
  -f target=staging \
  -f scenario=browse-dispensary
```

The workflow uploads the JSON report as a build artifact and posts a
summary to the workflow log.

---

## Pass/fail thresholds

Each script declares its thresholds in the `options.thresholds` block.
k6 exits non-zero if a threshold is violated, so the workflow fails
loudly on regression.

| Metric                 | Browse | Checkout | Driver GPS | Vendor RT |
| ---------------------- | ------ | -------- | ---------- | --------- |
| http_req_duration p95  | 500 ms | 1500 ms  | 250 ms     | 250 ms    |
| http_req_failed %      | 1%     | 1%       | 1%         | n/a       |
| iteration_duration p99 | 800 ms | 2500 ms  | n/a        | n/a       |
| ws_session_duration    | n/a    | n/a      | n/a        | full hold |
| dropped_iterations     | 0      | 0        | 0          | 0         |

Browse + checkout cover the spec §8.3 numerical commitments; driver GPS
and vendor realtime test for steady-state sustainability under the
realtime layer (not declared in §8.3 but implied by the SLO list).

---

## Interpreting failures

1. **Threshold breached on http_req_duration p95** — pull the matching
   route from the API's `/metrics` (`http_request_duration_seconds`
   histogram), find which percentile bucket overflowed, then EXPLAIN
   the slow query (the slow-query logger in
   `packages/db/src/client.ts` warns at 500ms — grep the API log for
   the offending label).
2. **dropped_iterations > 0** — k6 ran out of VUs to keep up.
   Either the server is back-pressuring or the test box ran out of
   open sockets. Check the API's `process_open_fds` Prom gauge against
   the system limit.
3. **ws_session_duration short** — Socket.io is dropping connections.
   Verify the realtime service's `socketio_active_connections` gauge
   and inspect the realtime logs for `disconnect` reasons.
4. **Compliance failures during checkout-burst** — the seed places all
   100 VUs in `delivery_zone_minneapolis`, all inside business hours
   (script clamps the run window). If compliance trips, the limit or
   geofence has regressed; the script bug-reports the first failure.

---

## Adding scenarios

1. Create `scenarios/<name>.js`.
2. Import `lib/auth.js` and `lib/seed-ids.js` — no duplication of the
   sign-in flow or the seeded ID list.
3. Declare `options.thresholds` from the start; merging in thresholds
   after a run is how you accidentally ship a no-op test.
4. Update this README's table and `loadtest/.github/workflows/load-test.yml`
   matrix.
