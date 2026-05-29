# Postgres / pgbouncer pool saturation

## When this fires

The `DBPoolWaiters` alert (pool waiters > 0 for 5m) page or the
`DBPoolHighUtilization` warning (pool utilization > 70% for 10m).
Both indicate the API can't get a Postgres connection fast enough
to keep up with request volume.

## Background

DankDash uses Railway-managed Postgres 16 + the Railway Connect
Pooler (pgbouncer in transaction mode). The API connects to the
pooler, not the DB directly — that's why we disable prepared
statements in `packages/db/src/client.ts` (pgbouncer in tx mode
rotates server connections between transactions, breaking the
prepared-statement protocol).

The api process holds a pg pool of `DATABASE_MAX_CONNECTIONS`
(default 20) per replica. Each pool sits behind the Railway
pooler. The "waiters" gauge counts callers blocked waiting for a
free _application-side_ connection — not a pooler connection.

So: `db_pool_waiting > 0` means the application pool is saturated.
The pooler may have idle capacity but the application can't reach
it because all 20 application-pool slots are busy.

## Diagnosis flow

### Step 1 — Identify the pressure source

Open the **DankDash — Postgres pool** dashboard.

| Symptom                                         | Likely cause                           |
| ----------------------------------------------- | -------------------------------------- |
| `db_pool_active` flat-line at pool size         | Long-running query holding connections |
| `db_pool_active` oscillating, `waiting` spiking | Real load — too few connections        |
| Slow-query rate spiking                         | Missing index or table bloat           |
| Slow-query p95 > 5s                             | Lock contention or maintenance task    |

### Step 2 — Confirm via pg_stat_activity

SSH into Railway via the `railway run` CLI (or use the Postgres
"Query" tab) and run:

```sql
SELECT pid, state, wait_event_type, wait_event, query_start,
       NOW() - query_start AS elapsed, left(query, 120) AS q
FROM pg_stat_activity
WHERE datname = current_database()
  AND state != 'idle'
ORDER BY query_start ASC;
```

If you see queries running > 30s, those are the culprits. The
`statement_timeout = '30s'` set by migration 0006 should kill
runaway queries — if you see something older, it's either:

- a worker connection (longer timeout configured), or
- a connection that was started before migration 0006 applied
  (recycle the pool by restarting the API).

### Step 3 — Check pgbouncer-side

The Railway Connect Pooler dashboard shows `cl_waiting` (clients
waiting on a pooler-server connection). If `cl_waiting > 0` _and_
our application `db_pool_waiting > 0`, the pooler is also
under-provisioned. Otherwise, the bottleneck is purely
application-side and raising the app pool is the fix.

## Resolution

### Path A — Runaway query

Kill the offending pid:

```sql
SELECT pg_cancel_backend(<pid>);   -- gentle, lets it clean up
SELECT pg_terminate_backend(<pid>); -- hard kill if cancel doesn't work
```

Then chase the root cause: open the slow-query panel on the
dashboard or query pg_stat_statements directly:

```sql
SELECT calls, total_exec_time / calls AS mean_ms, query
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY total_exec_time DESC
LIMIT 20;
```

A new entry with a high `mean_exec_time` is the regression. Use
`EXPLAIN (ANALYZE, BUFFERS) <query>` to confirm an index miss; add
an index in the next migration; reset `pg_stat_statements` after
deploy:

```sql
SELECT pg_stat_statements_reset();
```

### Path B — Real load, too few connections

Raise `DATABASE_MAX_CONNECTIONS` (Railway env var on the api
service). The pooler currently has 100 server connections
(`POSTGRESQL_MAX_CONNECTIONS` on the Postgres service); the api
runs at most 5 replicas; so 20×5 = 100 is the ceiling.

If you need more:

1. Raise the Postgres service's `max_connections` first.
2. Raise the pooler's `default_pool_size`.
3. Raise the api's `DATABASE_MAX_CONNECTIONS`.

Coordinated; do not raise the app pool past the pooler ceiling or
the pooler will refuse connections and the api will see
"server_login_retry timeout" errors instead.

### Path C — Lock contention

`pg_stat_activity.wait_event_type = 'Lock'` indicates blocked-by
another transaction. Run:

```sql
SELECT blocked_locks.pid AS blocked_pid,
       blocking_locks.pid AS blocking_pid,
       blocked_activity.query AS blocked_query,
       blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity
  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity
  ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

The `blocking_query` is the transaction holding the lock. Kill it
if it's not legitimate (e.g. an abandoned `BEGIN` from a debug
session). If it's a worker job, wait — workers run with longer
timeouts intentionally.

## Verification

After the fix:

1. `db_pool_waiting` returns to 0 within 2 minutes.
2. API latency p95 returns to baseline on the API Overview dashboard.
3. `pg_stat_activity` shows no queries older than 30s.
4. PagerDuty alert resolves automatically (the `for: 5m` clause
   means the alert closes when the condition has been false for
   that window).

## Postmortem

Mandatory if the saturation lasted > 15 min or required raising
pool size. Template TBD (Phase 22). Include:

- Root cause (Path A / B / C above).
- Time to detect (alert firing).
- Time to resolve.
- Why the index / config was missing (gap in the EXPLAIN audit?
  load test that didn't exercise the path?).
- Preventive action — usually adding the missing index, raising
  the pool size, or adjusting the timeout.

## Prevention

The Phase 21 k6 suite (`loadtest/scenarios/`) exercises 100
concurrent checkouts + 1000 browse VUs against staging. If a query
plan changes such that the pool would saturate under that load,
the load-test thresholds in those scripts fail before production
sees the issue. **Run the suite before any migration that touches
hot tables (orders, listings, order_events).**
