# Grafana alert triage

This runbook is the on-call's first stop when a PagerDuty page from
DankDash fires. Each section is keyed off the alert name so the
PagerDuty link the alert carries goes directly to the relevant
section.

All alerts carry a `severity` label:

- `critical` → routed to PagerDuty primary → pages on-call immediately.
- `warning` → routed to PagerDuty secondary → posts to `#ops-warnings`
  Slack, no page.

The fastest way to triage is usually:

1. **Find the dashboard the alert points at** (linked in each alert's
   `runbook_url` annotation, anchored to this file).
2. **Confirm the alert isn't a known false positive** (recent deploy
   in progress, scheduled maintenance, etc.).
3. **Open the runbook section below** that matches the alert.

## Index

| Alert                               | Severity | Dashboard                    |
| ----------------------------------- | -------- | ---------------------------- |
| `APIRequestLatencyP95`              | crit     | DankDash — API Overview      |
| `API5xxErrorRate`                   | crit     | DankDash — API Overview      |
| `APIUnhandledExceptionsBurst`       | warn     | DankDash — API Overview      |
| `APIRequestLatencyP95Warning`       | warn     | DankDash — API Overview      |
| `DBPoolWaiters`                     | crit     | DankDash — Postgres pool     |
| `DBPoolHighUtilization`             | warn     | DankDash — Postgres pool     |
| `DBSlowQueryP95`                    | warn     | DankDash — Postgres pool     |
| `RealtimeDisconnectRate`            | crit     | DankDash — Realtime Overview |
| `RealtimeActiveConnectionsCollapse` | crit     | DankDash — Realtime Overview |
| `RealtimeRedisOpsBurst`             | warn     | DankDash — Realtime Overview |
| `CartValidationFailureSpike`        | crit     | DankDash — Business KPIs     |
| `ComplianceBlocksSpike`             | crit     | DankDash — Business KPIs     |
| `IDScanDeclinedSpike`               | warn     | DankDash — Business KPIs     |

---

## api-latency

**Alert**: `APIRequestLatencyP95` (p95 > 500ms for 10m).

**What it means**: the 95th-percentile request latency across all
routes has exceeded the spec §8.3 SLO floor (500ms) for ten
straight minutes. This is the canonical "the API is slow" page.

**Immediate actions** (run in parallel where possible):

1. Open **DankDash — API Overview** dashboard. The "Top 10 slowest
   routes (p95)" panel tells you which routes are dragging the
   aggregate. A single route dominating → it's that route's
   problem; aggregate-wide degradation → look upstream (DB, Redis).
2. Open **DankDash — Postgres pool** dashboard. If pool waiters
   are non-zero, the DB is the bottleneck — jump to
   [pgbouncer-saturation](pgbouncer-saturation.md). If the slow-
   query panel is lit, there's a missing index or a runaway query.
3. Open `gh run list -L 5` and look for a recent deploy that
   correlates with the latency rise. Roll back via `gh workflow run
rollback.yml -f environment=production` if the timing matches.

**Verification**:

- p95 returns below 250ms on the API Overview dashboard.
- No PagerDuty incident in the past 5m on the same alert.

**Escalation**: if no improvement after 15m of investigation, page
the secondary on-call.

**Postmortem**: required for sustained >30m duration. Template in
`docs/runbooks/_postmortem-template.md` (Phase 22).

---

## api-5xx

**Alert**: `API5xxErrorRate` (5xx rate > 1% for 10m).

**What it means**: more than 1 in 100 requests is returning a 5xx
status. The exception filter has captured the underlying error to
Sentry; the dashboard's "Unhandled exceptions" panel is the
canonical signal.

**Immediate actions**:

1. Open Sentry: `https://sentry.io/organizations/dankdash/issues/?statsPeriod=15m`.
   The newest issue is almost always the cause.
2. Cross-reference with `gh run list -L 5`. A deploy in the past
   15m + a new Sentry issue = roll back.
3. If no recent deploy: check the **DankDash — Postgres pool**
   dashboard for connection errors (pool exhaustion can present as
   5xx via the timeout middleware).
4. If still unexplained: check `redis_connected_clients` on the
   realtime dashboard. A Redis outage causes BullMQ + Socket.io to
   throw, both surface as 5xx.

**Verification**:

- 5xx ratio drops below 0.5% on the dashboard.
- Sentry issue count stops growing.

**Escalation**: 5xx rate > 5% (10x SLO) is a P0 — page CEO + CTO
in addition to the secondary on-call.

---

## unhandled-exceptions

**Alert**: `APIUnhandledExceptionsBurst` (>5 in 5m).

**What it means**: code threw something that wasn't a `DomainError`
subclass or a Nest `HttpException`. These are always bugs (or
infrastructure failures the code didn't anticipate).

**Immediate actions**:

1. Open Sentry → newest issues, last 5m. Each carries
   `request_id` + `trace_id` tags from the global filter — click
   through to Tempo for the span timeline.
2. If a single user is hitting it: their next attempt will also
   fail — fixed by code fix, not retry.
3. If multiple users: usually a deploy regression. Roll back.

**Verification**:

- `http_exceptions_total{kind="unhandled"}` increase stops on the
  API Overview dashboard's panel.

**Escalation**: warning tier — no page unless growth continues.
Convert to a critical alert (manually) if Sentry issue volume
indicates ongoing impact.

---

## realtime-disconnects

**Alert**: `RealtimeDisconnectRate` (error-disconnect ratio > 5% for 10m).

**What it means**: more than 5% of Socket.io sessions are ending
in an error (transport drop, timeout, parse error) rather than a
clean disconnect. Baseline is 1-2% (mobile networks).

**Immediate actions**:

1. Open **DankDash — Realtime Overview**. The "Connections per
   second (by outcome)" panel shows which outcome label is spiking.
2. If `error` is dominant: look at the realtime process logs in
   Railway. Common causes: Redis adapter wedged (check
   `redis_connected_clients` panel), CPU throttling (Railway metrics),
   memory pressure forcing GC pauses.
3. If `rejected` is dominant: an auth change shipped that's
   refusing valid tokens. Roll back the most recent realtime deploy.
4. Restart the realtime process via Railway if logs show
   "ENOMEM" / OOM kill / event loop blocked > 1s.

**Verification**:

- Disconnect ratio returns to baseline (≤2%) on the dashboard.
- Active connections recover to their pre-incident level.

**Escalation**: 15m without improvement → page secondary +
notify CTO.

---

## realtime-down

**Alert**: `RealtimeActiveConnectionsCollapse` (active conns == 0
during business hours).

**What it means**: every WebSocket connection has dropped and none
are reconnecting. Either the realtime process is dead, the Railway
proxy lost route, or DNS broke for `realtime.dankdash.com`.

**Immediate actions**:

1. `curl https://realtime.dankdash.com/health/live` — if non-200,
   process is down. Restart via Railway dashboard.
2. If 200: clients can't reach it. Check Cloudflare DNS for
   `realtime.dankdash.com` (CNAME → Railway). Run
   `dig realtime.dankdash.com +short` from your laptop.
3. Check Railway service logs for the realtime app: any restart
   loop, missing env, missing Redis URL.

**Verification**:

- `realtime_active_connections > 0` on the dashboard.
- A test `wscat -c wss://realtime.dankdash.com/socket.io/?EIO=4`
  from your laptop receives the engine.io handshake.

**Escalation**: 5m without recovery → page CTO + Railway support.

---

## compliance-spike

**Alert**: `CartValidationFailureSpike` (rate > 5x baseline for 5m).

**What it means**: consumers are being told their carts are
non-compliant at 5x the previous-hour baseline. Either a real
compliance change shipped that's rejecting valid carts (bug), or
a UX bug is forcing every cart through the rejection branch (bug),
or coordinated abuse (rare).

**Immediate actions**:

1. Open **DankDash — Business KPIs** → "Cart validation failures
   by reason" panel. The dominant reason label tells you which
   rule is firing.
2. Cross-reference with `git log -- packages/compliance/` for any
   compliance code change in the last 24h. If yes: roll back.
3. If the rule is `THC_LIMIT_EXCEEDED` and the volume is
   widespread: check the catalog. A recent listing CSV import
   might have set wrong THC values for many products.
4. If the rule is `HOURS_OUTSIDE_WINDOW`: someone changed the
   business-hours config. Roll back the dispensary admin change.

**Verification**:

- Rate returns to within 2x baseline.
- "Cart validation failures by reason" panel shows the previously
  dominant reason has dropped.

**Escalation**: 30m sustained → engage legal + compliance lead.
This is the closest signal we have to "we're letting
non-compliant orders through" (the inverse symptom — too few
blocks — is just as bad).

---

## When in doubt

The fastest pivot is always:

1. **Open the trace** — every alert has metric labels that
   reference span attributes. Click into Tempo from the dashboard
   panel via the exemplar trace ID.
2. **Open Sentry** — if the symptom is errors, Sentry has the
   stack trace.
3. **Page the secondary** — better to escalate than to thrash.
