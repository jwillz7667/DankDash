# High order error rate

## Purpose

The order pipeline is the business. When a meaningful fraction
of `/v1/checkout` or `/v1/orders/*/transition` requests start
returning 4xx/5xx in production, we lose revenue per minute,
dispensary partners lose patience, and customers churn. This
runbook is the operator playbook for the **generic order-pipeline
degradation alert** — the one that fires before we know which
upstream is to blame.

It assumes the dedicated alerts (`AeropayHealthDown`,
`MetrcHealthDown`, `DbConnectionFailure`, `ComplianceEngineError`)
have **not** fired. If a specific upstream alert is firing in
parallel, use that runbook first; this one is the catch-all when
none of the targeted alerts have caught the cause.

## When to fire

The trigger is the `OrderErrorRateBurst` Grafana alert, defined
in `infra/grafana/alerts/orders.yml`:

```promql
sum(rate(http_requests_total{
  route=~"/v1/(checkout|orders/.*/transition)",
  status=~"5..|4(0[0-9]|1[0-3]|2[2-9])"
}[5m]))
/
sum(rate(http_requests_total{
  route=~"/v1/(checkout|orders/.*/transition)"
}[5m]))
> 0.05
```

A sustained 5% error rate over a 5-minute window pages. The
threshold is intentionally well below the rate at which a
business observer would notice — we want time to investigate
before the dispensary support inbox lights up.

Auxiliary signals that should be read alongside the burst alert:

- `compliance_check_failures_total` rate — a spike here without
  a corresponding `OrderErrorRateBurst` means the compliance
  engine is rejecting legitimate-looking carts (catalog drift,
  weight unit drift). Run the compliance-specific path below.
- `payment_transactions_total{status="failed"}` rate — typically
  caught by the Aeropay alert, but if Aeropay's synthetics pass
  and our checkout still fails, the problem is between us and
  Aeropay (egress, token cache, signing key).
- `order_state_transition_failures_total` — the XState reducer
  rejected a requested transition. Most often a client-API drift
  issue (an old build trying to make a transition that no longer
  exists).

## Procedure

### Step 0 — Acknowledge the page

Acknowledge PagerDuty. Set `#incidents` status:
`🚨 Order error rate elevated — investigating`. Capture the
alert payload (the route breakdown — `checkout` vs.
`transition` — is the first useful piece of data).

### Step 1 — Localize: which route, which dispensary, which user agent

The first 5 minutes are pure triage. Open the Grafana board
`orders/error-rate-drilldown` (`infra/grafana/dashboards/orders-errors.json`)
and capture:

- **Route split.** Checkout vs. transition. Checkout failures
  point at payment, compliance, or inventory. Transition
  failures point at the XState reducer or the realtime layer.
- **Status code distribution.** 422 dominates → validation /
  compliance. 409 → idempotency conflict or concurrent
  transition. 500 → server error, look at Sentry. 503 → upstream
  dependency unavailable.
- **Dispensary distribution.** Is it spread across all
  dispensaries, or concentrated on one? Concentration → that
  dispensary's catalog or POS is the issue. Spread → a platform
  issue.
- **User agent distribution.** Concentration on an iOS build
  number → a client-side bug shipped in the latest TestFlight.
  Spread → server-side.

Write these down in the incident channel. Pin the message.

### Step 2 — Read the Sentry digest

```sh
gh issue list --repo dankdash/dankdash --label sentry-grouped \
  --search 'created:>2026-05-22T00:00Z' --limit 20
```

Sentry buckets identical stack traces into a single grouped
issue. The top issue by event count in the last 30 minutes is
almost always the offender. Open the top issue, copy:

- The error class (`ComplianceError.tagMismatch`,
  `InventoryError.outOfStock`, `PaymentError.providerUnavailable`,
  etc.).
- The triggering route + DTO sample (PII redacted by pino).
- The deployment SHA that introduced the spike (Sentry's release
  comparison view).

### Step 3 — Decide path

Based on the dominant error class:

#### Path A: Compliance failures

- `ComplianceError.tagMismatch` / `INVALID_STRAIN_TYPE` / unit
  errors → catalog drift. Run:

  ```sql
  SELECT dispensary_id, COUNT(*) AS failures
    FROM compliance_check_log
   WHERE created_at > now() - interval '15 minutes'
     AND result = 'fail'
     AND failure_code LIKE 'CATALOG_%'
   GROUP BY 1 ORDER BY 2 DESC;
  ```

  Concentration on one dispensary → their POS pushed malformed
  data. Pause their catalog sync, escalate to the
  dispensary-onboarding team.

- `ComplianceError.weightOverLimit` / `THC_OVER_LIMIT` →
  customers are hitting the regulatory caps. **This is correct
  behavior, not a bug.** Verify the engine is returning the
  right error message and customers are seeing it cleanly, then
  silence the alert if the rate is otherwise healthy.

- `ComplianceError.outsideSaleHours` / `OUTSIDE_GEOFENCE` → same
  as above. Working as designed; check the customer-facing copy
  is shipped and clear.

If the failure code is unfamiliar, read `packages/compliance/src/errors.ts`
and grep `git log` for the introducing commit. A new code that
fires unexpectedly is usually a recent migration's CHECK constraint
catching legacy data.

#### Path B: Payment failures with Aeropay synthetic green

The synthetic passes against `/v1/ping` but our charges fail.
Possible causes, in order of likelihood:

1. **OAuth token cache stale.** `AeropayClient.getToken()`
   should refresh on 401 but a bug here is the most common cause.
   Force a token refresh:
   ```sh
   pnpm --filter @dankdash/aeropay exec -- \
     token-cache invalidate --env prod
   ```
2. **Signing key drift.** A recent rotation may have left one
   service holding the old key (see `docs/runbooks/jwt-key-rotation.md`
   — the same posture applies for Aeropay signing). Read
   `AEROPAY_SIGNING_KEY_ID` on each service.
3. **Idempotency-key collision.** Very rare; would show as
   `409 IDEMPOTENCY_CONFLICT`. Indicates `cart.id` was not
   UUIDv7-unique — probably a seed-data slip into prod.

#### Path C: Inventory / stock failures

`InventoryError.outOfStock` spike points at a sync issue with
one dispensary's POS. A real out-of-stock on a popular item is
not a 5% error rate event — the cart fails for a few people, the
item disappears from the menu after the first decrement, and the
rate stays low. Sustained 5% means the decrement is firing on
items the POS thinks are in stock.

Pause that dispensary's inventory webhook intake while you
investigate. Use the script:

```sh
pnpm --filter @dankdash/api exec -- \
  dispensary-tool inventory-pause <license> --reason 'webhook-drift'
```

#### Path D: State-machine transition failures

If transition-route 4xx/5xx dominates and no specific upstream
alert fires, the XState reducer rejected a transition. Look at
the rejected transitions:

```sql
SELECT from_status, to_status, COUNT(*) AS count
  FROM order_status_history
 WHERE created_at > now() - interval '15 minutes'
   AND transition_rejected_reason IS NOT NULL
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

A spike in a transition that used to work usually means a
recent backend deploy changed the reducer. Roll back the deploy
unless the rejected transition is one you _intended_ to disable
(in which case the iOS/driver clients need to ship the matching
release).

#### Path E: No clear dominant class — server 500s

If Sentry shows a smear of unrelated errors all from the same
recent deploy SHA, the deploy itself is the suspect. Run:

```sh
gh release list --repo dankdash/dankdash --limit 5
gh run list --repo dankdash/dankdash --workflow deploy.yml --limit 3
```

If a deploy landed within the last hour and is the suspected
cause: **roll back**.

```sh
railway redeploy --service api --version <prev-release-sha>
railway redeploy --service realtime --version <prev-release-sha>
railway redeploy --service workers --version <prev-release-sha>
```

Deploy and rollback are both <2 min on Railway. If the alert
clears after the rollback, the deploy was the cause; open a
post-incident ticket on the offending PR and require a
reproduction + fix before re-deploy.

### Step 4 — Communicate

If the error rate stays elevated >10 minutes:

- Status page: `Investigating elevated checkout failures`.
- `#vendors`: brief note. Vendors notice fast when their queue
  goes quiet.
- `#cs-alerts`: tell support what to say to inbound complaints.

Do not name a specific cause until you have confirmed it.
"We're investigating" is the right register; "Aeropay is down"
before confirming the synthetic is the wrong one.

### Step 5 — Recover and verify

After the suspected fix is applied:

1. Watch the burst alert for ≥10 minutes. The rate should
   return to <1% (typical baseline).
2. Run a synthetic checkout against staging mirroring prod:
   ```sh
   pnpm --filter @dankdash/api exec -- \
     synthetic-checkout --env prod-mirror
   ```
3. Update the status page to operational.
4. Resolve the page.

### Step 6 — Audit the order ledger

After the all-clear, run a reconciliation pass over orders
created during the incident:

```sql
SELECT id, status, created_at, total_cents
  FROM orders
 WHERE created_at BETWEEN '<incident-start>' AND '<incident-end>'
   AND status IN ('paymentFailed', 'placed');
```

For each `paymentFailed`:

- Was the payment actually attempted? Cross-check with the
  Aeropay reconciler.
- Did the customer receive a clear "your payment failed" message,
  or did the request just 500 out?
- If we charged them and the order never moved to `accepted`,
  refund proactively. **Do not wait for a customer complaint.**

For each `placed` order older than 5 minutes that did not
proceed to `accepted`:

- The order is stuck. The dispatcher should pick it up; check
  the workers logs for `dispatch.placed` events. Manually move
  if necessary.

## Postmortem template

Under `docs/incidents/order-pipeline/YYYY-MM-DD.md`:

- **Trigger** — which alert fired, what the rate climbed to,
  duration.
- **Localization** — route split, dispensary split, UA split.
- **Root cause** — error class, originating commit, the deploy
  story.
- **Customer impact** — order count blocked, dollar value,
  proactive refunds issued, support tickets created.
- **Resolution** — rollback / hotfix / config flip.
- **Followups** — alert tuning, missing dashboard panels, lint
  rules that would have caught the bad commit pre-merge.
