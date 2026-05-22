# Grafana provisioning — DankDash

This directory holds the **deterministic artifacts** the operator
imports into a Grafana Cloud stack (or a self-hosted Grafana) the
first time the production / staging environment is wired up. The
goal: a `git clone` plus three `curl` commands gives you the
dashboards + alert rules the on-call needs, with no clickops.

## Files

```
datasources/
  prometheus.yaml   # Mimir / Grafana Cloud Prometheus datasource
  tempo.yaml        # Tempo (OTLP traces) datasource — referenced by trace links

dashboards/
  api-overview.json        # API rate, latency (p50/p95/p99), errors by route
  realtime-overview.json   # Socket.io active conns, emit latency, ack failures
  workers-overview.json    # Cron job durations + last-run + success/failure
  db-pool.json             # Pool saturation, slow queries
  business-kpis.json       # Orders placed/delivered, payouts, ID scans

alerts/
  api-latency-and-errors.yaml      # API p95 > 500ms (10m) crit; 5xx > 1% warn
  db-saturation.yaml               # Pool waiters > 0 (5m) crit
  realtime-disconnect.yaml         # Disconnect rate > 5% (10m) crit
  compliance-failure-spike.yaml    # cart_validation_failed_total 5x baseline crit
```

## Prerequisites

The dashboards reference metrics produced by `@dankdash/observability`:

- `http_request_duration_seconds`, `http_exceptions_total` (api)
- `db_pool_*`, `db_slow_query_seconds` (api)
- `realtime_active_connections`, `realtime_emit_total`,
  `realtime_connections_total` (realtime)
- `worker_job_duration_seconds`, `worker_job_runs_total`,
  `worker_job_last_run_timestamp_seconds` (workers)
- `orders_placed_total`, `orders_delivered_total`,
  `payouts_processed_total`, `id_scan_completed_total`,
  `cart_validation_failed_total`, `compliance_check_blocked_total`
  (api)
- `redis_connected_clients`, `redis_ops_per_second` (realtime,
  workers)

`/metrics` is scraped on each runtime's healthcheck port; see each
service's `main.ts` for the exposed listener. The Prometheus scrape
config lives in the operator's `prometheus.yaml` (cluster side),
**not** in this directory — this directory is what the dashboards
need, not what the cluster needs.

## Importing — Grafana Cloud

> Substitute `${GRAFANA_URL}`, `${GRAFANA_API_KEY}`, and (for the
> alerts) `${PAGERDUTY_INTEGRATION_KEY}` from your stack's settings.

```bash
# 1. Create the datasources (skip if Grafana Cloud has Mimir wired
#    natively — Cloud's default Prometheus datasource is fine; only
#    Tempo needs a manual entry if you self-host the collector).
for ds in datasources/*.yaml; do
  curl -fSs -X POST "${GRAFANA_URL}/api/datasources" \
    -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
    -H "Content-Type: application/json" \
    --data "@${ds}"
done

# 2. Import the dashboards. Each JSON is the raw dashboard payload —
#    the import endpoint wraps it in {dashboard, overwrite} for us.
for dash in dashboards/*.json; do
  jq -n --slurpfile d "${dash}" \
        '{dashboard: $d[0], overwrite: true, message: "import via repo"}' \
  | curl -fSs -X POST "${GRAFANA_URL}/api/dashboards/db" \
    -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
    -H "Content-Type: application/json" -d @-
done

# 3. Apply the alert rules. These are Grafana Unified Alerting YAML
#    (provisioning format). PagerDuty integration is keyed off the
#    `notification` field on each alert; map it to your contact point
#    in the Grafana UI first if you haven't.
for rule in alerts/*.yaml; do
  curl -fSs -X POST "${GRAFANA_URL}/api/v1/provisioning/alert-rules" \
    -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
    -H "Content-Type: application/yaml" \
    --data-binary "@${rule}"
done
```

## Importing — self-hosted Grafana via Docker

```bash
docker run -d --name grafana \
  -p 3000:3000 \
  -v "$(pwd)/infra/grafana/dashboards:/etc/grafana/provisioning/dashboards" \
  -v "$(pwd)/infra/grafana/datasources:/etc/grafana/provisioning/datasources" \
  -v "$(pwd)/infra/grafana/alerts:/etc/grafana/provisioning/alerting" \
  grafana/grafana:11.3.0
```

Then sign in at `http://localhost:3000` (admin/admin) and confirm
the dashboards appear in the **General** folder. Alert rules show
under **Alerting → Alert rules → Provisioned**.

## PagerDuty wiring

The alert YAML refers to a Grafana contact point named
`pagerduty-primary` and `pagerduty-secondary`. Before applying the
alert rules:

1. In Grafana: **Alerting → Contact points → New** → type
   `PagerDuty`. Name it `pagerduty-primary`. Paste the integration
   key from PagerDuty's service settings.
2. Repeat for `pagerduty-secondary` (the warning-tier service).

The PagerDuty integration key is a **secret** — do NOT bake it into
this YAML. The contact point lives only in the Grafana stack.

## When to update the JSON

The dashboards reference metric names + label sets that change only
when the observability package's metric registry changes. When you
add a new metric in `packages/observability/src/metrics/`:

1. Add a panel to the relevant dashboard JSON in this directory.
2. Verify locally by running the dev `docker compose up` profile
   that includes Prometheus + Grafana, then opening the dashboard
   and confirming the panel populates against synthetic load.
3. Commit dashboard + metric in the same PR.

Conversely, if you remove or rename a metric, search this directory
for the old name and update the panels before the rename lands —
otherwise the dashboards 404 the metric and the on-call sees empty
panels at the moment they need the data.
