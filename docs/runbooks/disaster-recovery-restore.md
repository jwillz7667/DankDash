# Disaster recovery — Postgres restore drill

## Purpose

Per spec §10.5, DankDash commits to RTO ≤ 1 hour and RPO ≤ 5
minutes for the production Postgres database. This runbook is the
procedure for proving those numbers — both in scheduled drills
and in a real disaster.

The companion script `scripts/dr-restore.sh` is the executable
companion: it does the same steps, prints the elapsed time, and
runs the integrity checks. Use the script for drills; use this
runbook to understand each step (and in case the script fails
mid-restore).

## When to fire

- **Scheduled drill** — quarterly, run by the on-call into the
  staging environment. Result recorded in `PROGRESS.md` with the
  measured RTO/RPO actuals.
- **Real disaster** — production data loss (table dropped,
  corruption, ransomware, Railway region failure). PagerDuty does
  not fire this automatically; the operator declares the disaster.

## Background

Railway-managed Postgres takes a **continuous WAL backup** to
Railway's storage backend, with on-demand snapshots configurable
in the dashboard. Railway also ships nightly logical backups
(pg_dump) to Cloudflare R2 via our `apps/workers/backup.cron`
job (Phase 18) — those are the **recovery artifacts** this runbook
restores from.

The R2 bucket layout:

```
s3://dankdash-backups/postgres/
  daily/
    2026-05-20T03:00:00Z.dump          # pg_dump custom format
    2026-05-21T03:00:00Z.dump          # most recent
  weekly/
    2026-W19.dump
    2026-W20.dump
  yearly/
    2025.dump
    2026.dump
```

The dump files are pgcrypto-encrypted with the master key in
Railway's secret manager (`BACKUP_ENCRYPTION_KEY`). The restore
script decrypts in-flight.

## Pre-flight checks

Before kicking off the restore:

1. **Confirm the source backup file is recent.** A daily backup
   older than 26 hours means the cron failed — check the workers
   dashboard before restoring an old file.
2. **Confirm the target DSN is staging, not prod.** This script
   refuses to run against any host containing `prod` or `production`
   in the DSN; the operator-side `STAGING_DSN` must be explicit.
3. **Confirm the staging DB is currently empty or expendable.**
   The restore drops + recreates the schema; existing staging data
   is wiped.

## Procedure

### Step 1 — Set up env

```bash
export AWS_ACCESS_KEY_ID="<r2-access-key>"
export AWS_SECRET_ACCESS_KEY="<r2-secret-key>"
export AWS_ENDPOINT_URL="https://<r2-account-id>.r2.cloudflarestorage.com"
export AWS_REGION="auto"

export BACKUP_URI="s3://dankdash-backups/postgres/daily/2026-05-21T03:00:00Z.dump"
export STAGING_DSN="postgres://dankdash:<pw>@staging-pg.railway.app:5432/dankdash"
export BACKUP_ENCRYPTION_KEY="<from Railway secrets>"
```

The values come from:

- `AWS_*` → Cloudflare R2 → "Manage R2 API Tokens" → use the
  `dankdash-backups-readonly` token.
- `BACKUP_URI` → the dump you've decided to restore. For a drill,
  pick the most recent daily.
- `STAGING_DSN` → Railway dashboard → staging Postgres → "Connect"
  tab → "Postgres Connection URL". Use the private network URL if
  running from inside Railway; the public URL if running from
  your laptop.
- `BACKUP_ENCRYPTION_KEY` → Railway secrets → `BACKUP_ENCRYPTION_KEY`.

### Step 2 — Run the restore

```bash
./scripts/dr-restore.sh
```

The script will print the start time, then output the pg_restore
progress. On a 5GB database, this takes 8-15 minutes against
Railway's staging Postgres.

If you'd rather run the steps manually:

```bash
START_TS=$(date +%s)

# 2a — pull the encrypted dump
aws s3 cp "$BACKUP_URI" /tmp/restore.dump.enc \
  --endpoint-url "$AWS_ENDPOINT_URL"

# 2b — decrypt
openssl enc -aes-256-cbc -d \
  -in /tmp/restore.dump.enc \
  -out /tmp/restore.dump \
  -k "$BACKUP_ENCRYPTION_KEY"

# 2c — drop and recreate the schema
psql "$STAGING_DSN" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

# 2d — restore
pg_restore \
  --dbname="$STAGING_DSN" \
  --jobs=4 \
  --no-owner --no-privileges \
  --exit-on-error \
  /tmp/restore.dump

END_TS=$(date +%s)
echo "Elapsed: $((END_TS - START_TS))s"
```

### Step 3 — Integrity checks

Run these against the restored staging DB:

```sql
-- Row counts on the canonical tables
SELECT
  (SELECT COUNT(*) FROM users)          AS users,
  (SELECT COUNT(*) FROM dispensaries)   AS dispensaries,
  (SELECT COUNT(*) FROM orders)         AS orders,
  (SELECT COUNT(*) FROM order_events)   AS order_events,
  (SELECT COUNT(*) FROM payouts)        AS payouts;

-- order_events partitions reconciled
SELECT
  child.relname AS partition,
  pg_size_pretty(pg_relation_size(child.oid)) AS size
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'order_events'
ORDER BY child.relname;

-- Latest order_events timestamp (RPO measurement)
SELECT MAX(occurred_at) AS most_recent_event,
       NOW() - MAX(occurred_at) AS rpo_actual
FROM order_events;

-- Indexes intact
SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public';
-- expect ≥ 70 (12 from 0000 + earlier migrations + 4 from 0006)

-- pgcrypto extension present
SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'postgis', 'pg_stat_statements');
-- expect 3 rows
```

The `rpo_actual` value is what we report — that's the time
between the most recent recorded order_event and "now". The drill
passes if `rpo_actual` < 1 hour (≈ daily backup lag).

### Step 4 — Record the actuals

Append to `PROGRESS.md`:

```markdown
### DR drill — YYYY-MM-DD

- Backup URI: `<URI>`
- Backup age at restore: `<H>h<M>m`
- Restore elapsed (RTO): `<H>h<M>m<S>s`
- RPO actual (most recent event delta): `<H>h<M>m`
- Verification: ✅ all checks pass / ❌ <issues>
- Notes: <anything unusual>
```

Then tear down the staging DB if it's not needed for further
testing (Railway "Reset Database" in the dashboard).

## Failure modes

| Failure                                                   | Cause                                    | Fix                                                                          |
| --------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `aws s3 cp: NoSuchKey`                                    | The dump file you named doesn't exist    | List the bucket; pick a real key                                             |
| `openssl: bad decrypt`                                    | `BACKUP_ENCRYPTION_KEY` wrong or rotated | Confirm the key against Railway secrets; rotate didn't lose archive          |
| `pg_restore: ERROR: relation already exists`              | The drop+create in step 2c didn't run    | Re-run step 2c; ensure no other session holds the schema                     |
| `pg_restore: ERROR: extension "postgis" is not available` | Staging DB image is missing PostGIS      | Install PostGIS on the Railway plugin or pick a Postgres image that ships it |
| `psql: FATAL: connection refused`                         | Wrong DSN; staging Postgres not running  | Verify Railway service is up                                                 |

## Real disaster (not a drill)

If production is genuinely broken:

1. **Stop the bleeding first.** Put the api in maintenance mode
   (`gh workflow run maintenance.yml -f environment=production`).
   This serves a static page from Cloudflare; users see "we're
   restoring, back in 1 hour".
2. **Decide on the restore target.** Restoring on top of the
   running prod Postgres is risky. The standard practice is:
   - Provision a fresh Railway Postgres service.
   - Restore the most-recent backup to it.
   - Run the integrity checks above.
   - Update the api's `DATABASE_URL` to point at the new instance.
   - Verify; then decommission the old broken instance.
3. **The clock starts when prod went bad and stops when the api
   serves real traffic again.** That's the RTO.
4. **Communicate.** Status page update every 15 minutes minimum.
   Slack `#incident-active` updates every 5.

## Postmortem

Mandatory for any real disaster. The drill doesn't require one,
but if the drill exceeded the RTO target, file a postmortem-style
note in `PROGRESS.md` with what needs to change before next quarter.
