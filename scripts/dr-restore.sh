#!/usr/bin/env bash
# DR restore — fetches an encrypted pg_dump from R2, decrypts it,
# restores it against ${STAGING_DSN}, runs integrity checks, and
# prints the elapsed time (the RTO actual) and the most-recent
# event timestamp (the RPO actual).
#
# Companion to docs/runbooks/disaster-recovery-restore.md. Do not
# run against production — the script refuses any DSN containing
# `prod` or `production`.
#
# Required env:
#   BACKUP_URI              s3://bucket/path/dump-key.enc
#   STAGING_DSN             postgres://...
#   BACKUP_ENCRYPTION_KEY   base64 key used by the backup cron
#   AWS_ACCESS_KEY_ID       (R2 token — readonly)
#   AWS_SECRET_ACCESS_KEY   (R2 token — readonly)
#   AWS_ENDPOINT_URL        R2 endpoint URL
# Optional env:
#   AWS_REGION              defaults to "auto"
#   RESTORE_JOBS            pg_restore --jobs value, default 4
#   KEEP_TMP                if set, do not delete the decrypted dump
#
# Exit codes:
#   0 — restore succeeded, all integrity checks pass
#   1 — preflight env / DSN check failed
#   2 — fetch from R2 failed
#   3 — decrypt failed
#   4 — pg_restore failed
#   5 — integrity check failed

set -euo pipefail

# ----- preflight --------------------------------------------------------------

require() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "error: required env var \$${var} is not set" >&2
    exit 1
  fi
}

require BACKUP_URI
require STAGING_DSN
require BACKUP_ENCRYPTION_KEY
require AWS_ACCESS_KEY_ID
require AWS_SECRET_ACCESS_KEY
require AWS_ENDPOINT_URL

export AWS_REGION="${AWS_REGION:-auto}"
RESTORE_JOBS="${RESTORE_JOBS:-4}"

case "$STAGING_DSN" in
  *prod*|*production*)
    echo "error: STAGING_DSN appears to reference production. Refusing." >&2
    echo "       DSN: ${STAGING_DSN}" >&2
    exit 1
    ;;
esac

for cmd in aws psql pg_restore openssl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
done

# ----- temp paths -------------------------------------------------------------

TMPDIR_LOCAL="$(mktemp -d -t dankdash-dr-XXXXXX)"
ENC_PATH="${TMPDIR_LOCAL}/restore.dump.enc"
DUMP_PATH="${TMPDIR_LOCAL}/restore.dump"

cleanup() {
  if [[ -z "${KEEP_TMP:-}" ]]; then
    rm -rf "$TMPDIR_LOCAL"
  else
    echo "kept temp dir: $TMPDIR_LOCAL" >&2
  fi
}
trap cleanup EXIT

# ----- timing -----------------------------------------------------------------

START_TS=$(date +%s)
echo "==> starting DR restore at $(date -u +%FT%TZ)"
echo "    backup:  $BACKUP_URI"
echo "    target:  ${STAGING_DSN%%@*}@***"

# ----- fetch ------------------------------------------------------------------

echo "==> fetching encrypted dump from R2..."
if ! aws s3 cp "$BACKUP_URI" "$ENC_PATH" \
     --endpoint-url "$AWS_ENDPOINT_URL" \
     --no-progress; then
  echo "error: aws s3 cp failed" >&2
  exit 2
fi
echo "    fetched $(du -h "$ENC_PATH" | awk '{print $1}')"

# ----- decrypt ----------------------------------------------------------------

echo "==> decrypting..."
if ! openssl enc -aes-256-cbc -d \
     -pbkdf2 \
     -in "$ENC_PATH" \
     -out "$DUMP_PATH" \
     -k "$BACKUP_ENCRYPTION_KEY"; then
  echo "error: openssl decrypt failed (wrong BACKUP_ENCRYPTION_KEY?)" >&2
  exit 3
fi
echo "    decrypted $(du -h "$DUMP_PATH" | awk '{print $1}')"

# ----- drop + recreate --------------------------------------------------------

echo "==> dropping + recreating public schema on staging..."
psql "$STAGING_DSN" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL

# ----- restore ----------------------------------------------------------------

echo "==> pg_restore (jobs=${RESTORE_JOBS})..."
RESTORE_START=$(date +%s)
if ! pg_restore \
     --dbname="$STAGING_DSN" \
     --jobs="$RESTORE_JOBS" \
     --no-owner --no-privileges \
     --exit-on-error \
     --verbose \
     "$DUMP_PATH"; then
  echo "error: pg_restore failed" >&2
  exit 4
fi
RESTORE_END=$(date +%s)
echo "    pg_restore completed in $((RESTORE_END - RESTORE_START))s"

# ----- integrity checks -------------------------------------------------------

echo "==> running integrity checks..."

CHECKS=$(psql "$STAGING_DSN" -t -A -F'|' <<'SQL'
SELECT 'users',          COUNT(*) FROM users
UNION ALL SELECT 'dispensaries',   COUNT(*) FROM dispensaries
UNION ALL SELECT 'orders',         COUNT(*) FROM orders
UNION ALL SELECT 'order_events',   COUNT(*) FROM order_events
UNION ALL SELECT 'payouts',        COUNT(*) FROM payouts
UNION ALL SELECT 'indexes',        COUNT(*) FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'extensions',     COUNT(*) FROM pg_extension
                                   WHERE extname IN ('pgcrypto', 'postgis', 'pg_stat_statements');
SQL
)

echo "$CHECKS" | column -s'|' -t

if ! echo "$CHECKS" | awk -F'|' '$1=="extensions" && $2<3 { exit 1 }'; then
  echo "error: expected 3 extensions (pgcrypto, postgis, pg_stat_statements), got fewer" >&2
  exit 5
fi
if ! echo "$CHECKS" | awk -F'|' '$1=="indexes" && $2<60 { exit 1 }'; then
  echo "error: index count below 60 — schema may be incomplete" >&2
  exit 5
fi

RPO_ACTUAL=$(psql "$STAGING_DSN" -t -A <<'SQL'
SELECT EXTRACT(EPOCH FROM (NOW() - MAX(occurred_at)))::int
FROM order_events;
SQL
)
RPO_HM="$((RPO_ACTUAL / 3600))h$(( (RPO_ACTUAL % 3600) / 60 ))m"

# ----- summary ----------------------------------------------------------------

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
RTO_HM="$((ELAPSED / 3600))h$(( (ELAPSED % 3600) / 60 ))m$((ELAPSED % 60))s"

echo ""
echo "============================================================"
echo "DR restore complete"
echo "============================================================"
echo "  Backup URI:       $BACKUP_URI"
echo "  Target:           ${STAGING_DSN%%@*}@***"
echo "  RTO (elapsed):    ${RTO_HM}"
echo "  RPO actual:       ${RPO_HM}  (most-recent order_event lag)"
echo "  Started:          $(date -u -r "$START_TS" +%FT%TZ)"
echo "  Finished:         $(date -u -r "$END_TS" +%FT%TZ)"
echo "============================================================"
echo ""
echo "Record these numbers in PROGRESS.md under the DR drill entry."
