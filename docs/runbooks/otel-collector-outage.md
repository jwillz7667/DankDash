# OpenTelemetry collector outage

## When this fires

There is no Prometheus alert that directly fires "OTel is down" —
the absence of traces is detected the moment the on-call opens
Tempo and finds the time range is empty. Symptoms that lead here:

- Tempo's "Search" returns no results for the past 15m even though
  the api is taking requests.
- `dankdash-api-overview` panels populate (metrics still arrive),
  but exemplar links (the small dot icon on each histogram bucket)
  produce "trace not found" when clicked.
- Sentry issues come in _without_ a `trace_id` tag.

## Background

`packages/observability/src/otel/sdk.ts` initialises a Node OTel
SDK in api, realtime, and workers. The SDK exports via
**OTLP/HTTP** to whatever `OTEL_EXPORTER_OTLP_ENDPOINT` env var
points at. In staging/prod that's the Grafana Cloud OTLP gateway;
in local docker-compose it's a Jaeger container.

Metrics (Prometheus) go via the `/metrics` scrape, not via OTel —
so metrics keep flowing even when OTel is broken. Logs go via pino
direct to stdout, also independent of OTel. The only thing OTel
ships is **spans**.

## Diagnosis

### Step 1 — Is the SDK initialised?

Find a recent api log line and look for the `traceId` field. The
pino mixin (`packages/observability/src/logging/pino-mixin.ts`)
attaches `traceId` only if OTel is active.

```bash
# Tail the api log via Railway CLI
railway logs -s api --tail | head -50 | jq -r 'select(.requestId) | "\(.requestId) \(.traceId // "no-trace") \(.msg)"'
```

- All lines `no-trace` → SDK didn't start. Check api startup logs
  for an error from `initObservability()`.
- Lines have `traceId` → SDK is running; problem is downstream.

### Step 2 — Is the endpoint reachable?

From the api host (use Railway's "Shell" tab):

```bash
curl -v --max-time 5 \
  -H "Content-Type: application/x-protobuf" \
  --data-binary @/dev/null \
  "${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces"
```

Expected: a 400 (the body is empty/garbage) but you connected.

Possible failures:

- **DNS resolution failed** → the endpoint URL is wrong. Compare
  env var to Grafana Cloud's "Connections" page.
- **TLS handshake failed** → certificate chain issue. Grafana
  Cloud uses Let's Encrypt; if the node's CA bundle is stale, the
  fix is a Docker image rebuild.
- **401 / 403** → the API key has expired or been rotated. Mint a
  new one in Grafana Cloud → "Access Policies".
- **502 / 504 from the gateway** → Grafana Cloud is having an
  outage. Check `status.grafana.com`.
- **Timeout** → network egress is broken (Railway → outbound). Open
  a Railway support ticket; meanwhile, OTel will fall back to its
  in-memory buffer until that overflows, then drop spans.

### Step 3 — Is the exporter pipeline backed up?

The SDK's `BatchSpanProcessor` has an internal queue. If exports
are failing fast, the queue fills, and the SDK drops new spans
silently. Look for these warning lines in the api logs:

```text
{"level":40,"msg":"OTLP export failed","attempts":3,"errors":["..."]}
{"level":40,"msg":"OTLP queue full, dropping spans","dropped":<count>}
```

If you see queue-full warnings, raise the queue size (env:
`OTEL_BSP_MAX_QUEUE_SIZE`, default 2048) or lower the export delay
(`OTEL_BSP_SCHEDULE_DELAY`, default 5000ms) **temporarily** until
the downstream recovers. Don't leave those raised — they're
band-aids.

## Resolution

### Path A — Credential expired

1. Mint a new Grafana Cloud API key (Access Policies → name it
   `otel-prod-2026-MM` so we can audit later).
2. Update the Railway env var `OTEL_EXPORTER_OTLP_HEADERS`
   (it's a comma-separated `key=value` list — the auth header
   lives in here).
3. The api/realtime/workers services auto-restart on env change.
4. Verify in Tempo within 5 min.

### Path B — Endpoint outage

There's nothing to do but wait. Spans buffer in memory for ~10
seconds before being dropped (BatchSpanProcessor default). Long
outages → spans lost. Metrics + Sentry + logs continue working;
trace context is lost only for the outage window.

Once Grafana Cloud is back, no action needed — exports resume
automatically.

### Path C — Network egress broken

Railway support ticket. Meanwhile, `Sentry.captureException` calls
that include `trace_id` still work (Sentry has independent egress),
so production debuggability is degraded but not gone.

## Verification

1. New traces appear in Tempo within 5 min of the fix.
2. The exemplar link on a histogram bucket on the API Overview
   dashboard opens a real trace.
3. Sentry issues carry a `trace_id` tag again.

## Postmortem

Required for any outage > 30 min. Capture:

- Root cause (credential / endpoint / egress).
- How we found out (passive observation by on-call vs. operator-
  noticed during an unrelated investigation).
- How long traces were lost — and what we could _not_ debug as a
  consequence.
- Did we add a synthetic check to detect this earlier?

## Prevention

There's no current alert for "trace volume dropped to zero". This
is an explicit accepted gap — adding such an alert would require:

- Computing the rate of `traces_ingested` from Grafana Cloud's API,
  which adds a poll loop.
- A baseline model so the alert doesn't fire during low-traffic
  periods (e.g. 3am Sunday).

The cost-benefit didn't justify it for Phase 21. Reconsider in
Phase 22 if we see this runbook fire more than once.
