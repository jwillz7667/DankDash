# Postgres failover

## Purpose

Production Postgres on Railway is configured with a primary and
a hot-standby replica in the same region (see ADR
`0002-drizzle-orm.md` and the Railway project topology). Failover
is the procedure for **promoting the standby to primary** when
the primary becomes unavailable. This is distinct from
`disaster-recovery-restore.md`, which covers rebuilding from
backup when both nodes are lost or when corruption needs to be
walked back.

The RTO target for failover is **≤ 5 minutes**; the RPO target
is **0** (synchronous replication on critical tables; see the
"Synchronous commit" section).

## When to fire

- **Primary unreachable.** The api `/health/ready` Postgres probe
  fails for 3 consecutive scrape intervals (90 seconds). Grafana
  alert `PostgresPrimaryDown` → PagerDuty.
- **Replication lag > 60s sustained.** `PostgresReplicationLag`
  alert; the standby cannot tolerate a much longer lag without
  risking data loss on failover. If the primary then dies,
  failover decisions get harder.
- **Connection pool exhaustion with primary healthy.** Different
  problem — see `docs/runbooks/pgbouncer-saturation.md`. Do not
  failover; failover replaces one healthy box with another healthy
  box and does nothing for saturation.
- **Suspected on-disk corruption.** Failover gives a clean replica;
  this is the right move while you investigate the primary.
  Restoring from backup may also be required afterward.

If both nodes are unreachable, this is **not** a failover scenario
— use `disaster-recovery-restore.md` instead.

## Background

### Topology

```
                ┌────────────────────────────────┐
                │ Railway Postgres 16 + PostGIS  │
                │   ┌──────────────┐             │
                │   │ Primary      │  WAL ───┐   │
                │   │ pg-primary   │         │   │
                │   └──────┬───────┘         │   │
                │          │ sync replication ▼   │
                │   ┌──────┴───────┐             │
                │   │ Standby      │             │
                │   │ pg-standby   │             │
                │   └──────────────┘             │
                └────────────────────────────────┘
```

The standby uses **synchronous_commit = remote_write** on the
small set of tables where RPO=0 matters (`orders`,
`order_items`, `order_events`, `payment_transactions`,
`metrc_receipts`). Other tables use the default async commit and
can lose up to ~`max_wal_senders` lag of writes — acceptable for
catalog/inventory which can be resynced from the dispensary POS.

`DATABASE_URL` in production resolves through Railway's internal
DNS to `pg-primary.railway.internal`. Failover changes this DNS
record to point at the new primary; applications reconnect when
their pool sees connection failures.

### Why we promote rather than restart

A restart of the primary fixes some failure modes (OOM, brief
network blip). A promote of the standby fixes more failure modes
(filesystem corruption, kernel hang, hardware fault on the
primary host) at the cost of a one-time disruption.

The default posture is to **promote**, not restart, once the
PagerDuty page has been live for >5 minutes without a clear
recovery signal from the primary. Faster decision-making here
costs less than a longer outage.

## Pre-flight checks

Before issuing the promote:

1. **Confirm the primary is actually down.** From a Railway shell
   on the api service:
   ```sh
   psql "$DATABASE_URL" -c 'SELECT 1' --connect-timeout=5
   ```
   If this hangs, the primary is unreachable.
2. **Confirm the standby is healthy.** From a Railway shell:
   ```sh
   psql "$DATABASE_REPLICA_URL" -c "SELECT pg_is_in_recovery(), now()"
   ```
   Must return `t` and a current timestamp. If `f`, the standby
   has already been promoted (someone else fired this runbook;
   sync up in `#incidents` before doing anything).
3. **Confirm replication lag is acceptable.** From the standby:
   ```sh
   psql "$DATABASE_REPLICA_URL" -c "
     SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS replay_lag_bytes,
            EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS replay_lag_seconds;
   "
   ```
   Acceptable: `replay_lag_seconds < 5`. If the standby is more
   than 60 seconds behind, the RPO=0 commitment is voided for the
   gap and you must escalate to the CEO before promoting —
   promoting in this state means losing the in-flight orders
   that committed to the primary but did not replicate.
4. **Snapshot the standby state.** This is the "before" record
   for the postmortem.
   ```sh
   psql "$DATABASE_REPLICA_URL" -c "
     SELECT pg_last_wal_receive_lsn(),
            pg_last_wal_replay_lsn(),
            pg_last_xact_replay_timestamp();
   " > /tmp/standby-state-<ts>.txt
   ```

## Procedure

### Step 0 — Acknowledge

PagerDuty ack. `#incidents` status:
`🚨 Postgres failover — promoting standby`. Tag `@platform-on-call`
and `@cto`. Failover is a no-going-back operation; the CTO needs
to know it is happening even if their approval is not required.

### Step 1 — Stop new writes (optional, depending on the failure)

If the primary is hard-down (no connections accepted), skip this
step — the writes are already stopped. If the primary is reachable
but degraded (slow queries, replication broken, suspected
corruption), put the app in read-only mode while you promote.

```sh
# Flips GrowthBook feature `database.read_only` to true.
# api hooks this in the request-scoped DB middleware: writes
# return 503 ServiceUnavailable; reads continue from the standby
# via the replica DSN.
pnpm --filter @dankdash/api exec -- \
  feature-flag set database.read_only true --env prod \
  --note 'pre-failover'
```

### Step 2 — Promote the standby

In Railway dashboard → Postgres project → Replicas → `pg-standby`:

1. Click `Promote to primary`.
2. Confirm. Railway:
   - Stops replication from the old primary.
   - Issues `pg_promote()` on the standby.
   - Repoints the internal DNS `pg-primary.railway.internal` to
     the promoted node.
   - Marks the old primary as `decommissioning`.

Verify promotion completed:

```sh
psql "$DATABASE_URL" -c "SELECT pg_is_in_recovery()"
# → must return f
```

If the promote hangs in the Railway dashboard, escalate
immediately to Railway support — manual `pg_promote()` over a
psql shell against the standby is the operator-side override:

```sh
psql "$DATABASE_REPLICA_URL" -c "SELECT pg_promote(wait := true, wait_seconds := 60)"
```

Then update the Railway DNS record manually via their CLI:

```sh
railway db set-primary <project-id> <standby-instance-id>
```

### Step 3 — Reconnect applications

The application pools (`pg` / `pg-pool`) catch connection
failures and reconnect. Verify by hitting each service's
readiness probe:

```sh
for svc in api realtime workers; do
  echo -n "$svc: "
  curl -sS https://$svc.dankdash.com/health/ready
  echo
done
```

All three should return `{ "db": "ok", ... }` within 30 seconds
of the DNS flip. If one stays in `db: error`, force a redeploy:

```sh
railway redeploy --service <name>
```

### Step 4 — Re-establish RLS GUCs

Row-level security on `orders`, `order_items`, `cart_items`,
`dispensary_listings`, `payouts`, `payment_transactions` relies
on `app.current_dispensary_id` and `app.current_user_id` being
set per request via `SET LOCAL` in the api's transaction
middleware. The middleware sets these on every transaction
opening, so they re-establish themselves naturally on the next
request — no operator action required.

If you see RLS errors in Sentry within the first minute after
failover, that is a sign the api is still using its pre-failover
connection pool. Force the redeploy from Step 3.

### Step 5 — Disable read-only mode

If you flipped `database.read_only` in Step 1, flip it back now.

```sh
pnpm --filter @dankdash/api exec -- \
  feature-flag set database.read_only false --env prod \
  --note 'post-failover restored'
```

### Step 6 — Provision a new standby

The promoted node is now the primary; the cluster has no
replica. **Do not stay in this state past the end of the
incident.** In Railway dashboard:

1. Add a new replica.
2. Wait for the initial base-backup + WAL catchup (typically
   10–30 minutes on a production-sized DB).
3. Confirm replication is streaming:
   ```sh
   psql "$DATABASE_URL" -c "
     SELECT application_name, state, sync_state,
            pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
       FROM pg_stat_replication;
   "
   ```
   Want `state='streaming'`, `sync_state='sync'`, lag close to
   zero.

Until Step 6 completes, the cluster has no fault tolerance — a
second failure would force a restore from backup. Treat the
incident as open until Step 6 is done.

### Step 7 — Acknowledge and clean up

- Update the status page: `Operational`.
- Resolve PagerDuty.
- Schedule the post-incident review (see template below).

## Reconciliation: did we lose data?

The synchronous-commit tables (`orders`, `order_items`,
`order_events`, `payment_transactions`, `metrc_receipts`) had
RPO=0 if Step 1 pre-flight #3 passed. For async tables, run:

```sql
-- Compare row counts pre/post failover for the high-volume
-- async tables. Run on the new primary; compare with the
-- count from the standby snapshot taken in pre-flight #4.
SELECT 'cart_items' AS tbl, COUNT(*) FROM cart_items
UNION ALL
SELECT 'catalog_listings', COUNT(*) FROM catalog_listings
UNION ALL
SELECT 'driver_locations', COUNT(*) FROM driver_locations;
```

Any drop > 0 from the pre-failover count is data loss. Most
likely: `driver_locations` (high-write, async). These resync
from the live drivers on their next ping; no recovery action.

Catalog/inventory drops indicate a dispensary POS sync that
needs to be re-fired:

```sh
pnpm --filter @dankdash/workers exec -- \
  resync-dispensary-catalog --since '<failover-time>' --env prod
```

## Rollback

A failover cannot be rolled back. The old primary is decommissioned;
its WAL is the source-of-truth recovery artifact if a restore is
needed, but the new primary is now authoritative.

If the new primary turns out to be corrupted or unsuitable, the
recovery path is `disaster-recovery-restore.md` — restore from
backup to a fresh node, repoint DNS again. **Do not attempt to
re-promote the old primary** — its WAL has diverged from the
new primary the moment Step 2 completed.

## Postmortem template

Under `docs/incidents/db-failover/YYYY-MM-DD.md`:

- **Trigger** — alert that fired, time-to-page, the primary
  failure mode (hung, crashed, corrupted, unreachable).
- **Pre-flight state** — replication lag at promote time, sync
  table RPO.
- **Promote time** — Step 2 start to Step 4 complete.
- **Total outage** — alert fire to read-only-off (Step 5).
- **Data loss** — async-table drops by name + count.
- **New standby provisioned** — time to Step 6 complete.
- **Followups** — alert tuning, promote-script gaps, Railway
  support escalation experience.
