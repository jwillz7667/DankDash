# Aeropay outage

## Purpose

Aeropay is our ACH-rails payment processor. Cannabis cannot legally
ride Visa/Mastercard interchange under federal banking rules, so
Aeropay is a hard dependency — when it is down, **DankDash cannot
charge new orders**. This runbook is the operator playbook for
detecting, mitigating, and recovering from an Aeropay outage with
the smallest possible exposure to in-flight orders, the dispensaries
that count on us for revenue, and the customers who have already
spent time building a cart.

The companion code lives in:

- `packages/aeropay/` — the OAuth-credentialed client, Redis token
  cache, idempotency-key generator, and request signer.
- `apps/api/src/features/payments/` — the `PaymentService` that
  composes a checkout transaction around an Aeropay charge.
- `apps/workers/src/jobs/payment-reconciliation.cron.ts` — the
  cron that reconciles Aeropay's settled-batch report against our
  `payment_transactions` ledger.

## When to fire

Any one of these signals is enough to declare the runbook in
effect:

- **Synthetic check failed.** The `aeropay-health` probe in
  `apps/workers/src/jobs/health-probe.cron.ts` calls
  `GET https://api.aeropay.com/v1/ping` every 60 seconds and writes
  the result to the `aeropay_health_total{result}` Prometheus
  counter. Three consecutive failures fires
  `AeropayHealthDown` (Grafana alert `alerts/aeropay.yml`) →
  PagerDuty.
- **Spike in `payment_transactions.status='failed'`.** The
  Sentry alert `payment-failure-rate-burst` fires when failures
  exceed 5/min sustained for 3 min. Most often this is a single
  Aeropay endpoint failing rather than a full outage — check the
  per-endpoint breakdown panel before declaring an outage.
- **Aeropay status page advisory.** `status.aeropay.com` (RSS
  subscribed in BetterStack) posts incident notices. A "Major
  Outage" or "Service Disruption" badge with a posted ETA is
  authoritative — fire the runbook even if our synthetics are
  still passing, because we want the kill switch up before the
  failure rate climbs.
- **Manual report.** Engineering, support, or a dispensary
  partner reports failed checkouts that match the Aeropay error
  signature ("Provider unavailable", 5xx from `/v1/charges`).

If you cannot tell whether the failure is on our side or theirs,
**default to declaring** — the kill switch costs us a few minutes
of revenue; a stuck queue of failed charges costs us hours of
support and ledger reconciliation work.

## Background

### What an Aeropay charge looks like end-to-end

1. **Checkout intent.** Customer taps "Pay" on `checkout.dankdash.com`.
   `POST /v1/checkout` runs the compliance evaluation in the same
   DB transaction that decrements inventory, inserts the order,
   and writes `payment_transactions(status='pending', provider_ref=null)`.
   Idempotency key = `cart.id` (UUIDv7); a retry from the same
   cart returns the same payment row.
2. **Provider call.** Outside the DB transaction, the
   `PaymentService` calls `aeropay.createCharge({...})` with the
   idempotency key on the wire. The response carries
   `aeropay.charge_id` and `status='processing'`.
3. **Persist.** A short follow-up txn writes
   `payment_transactions.provider_ref = aeropay.charge_id`,
   `status='processing'`. The order moves `placed → accepted`
   only after this row updates.
4. **Settlement webhook.** Aeropay POSTs `/webhooks/aeropay/settled`
   over the next 1–3 business days when ACH clears. Worker
   verifies the HMAC, idempotency-checks `event.id`, and writes
   `payment_transactions.status='settled'` plus the ledger entries.

The window of risk during an outage is **step 2**. If the provider
call hangs or 5xx's, we do not know whether Aeropay received the
charge — so a naive retry could double-charge the customer.
**The idempotency key is what saves us**: retrying with the same
key is safe; Aeropay returns the prior response if any.

### What we can and cannot do offline

- ✅ **Browse menus.** Catalog reads (`/v1/dispensaries/*/menu`)
  are unaffected — no provider call.
- ✅ **Build a cart.** Server-cart operations (`/v1/cart/items`)
  do not call Aeropay.
- ✅ **Show a compliance preview.** The compliance engine is pure
  Postgres + our code.
- ❌ **Check out.** `/v1/checkout` always calls Aeropay. The kill
  switch lives here.
- ⚠ **Dispatch and deliver in-flight orders.** Orders that already
  reached `accepted` (status ≥ step 3 above) have a valid
  `processing` charge. Dispatch and delivery can proceed; the
  settlement webhook just lands later than usual.

## Procedure

### Step 0 — Acknowledge the page

Acknowledge PagerDuty. Set Slack status in
`#incidents` to `🚨 Aeropay outage — investigating`. Add a brief
note (one sentence) about which signal fired.

### Step 1 — Confirm the outage is upstream, not us

Run from a laptop on a non-Railway network (so we are not
shadowing a Railway egress problem):

```sh
# 1. Health endpoint
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" \
  https://api.aeropay.com/v1/ping

# 2. A signed echo (proves OAuth still works)
pnpm --filter @dankdash/aeropay run probe -- --env prod
```

If both fail with 5xx/timeouts and the status page also shows red,
the outage is real. If the health endpoint is green but `/v1/charges`
is failing, this is a **partial outage** — escalate to Aeropay
support immediately because our synthetic does not catch this
class on its own. Treat as a full outage for the kill-switch
decision regardless.

If our laptop probe passes but production keeps failing, the
problem is between Railway and Aeropay (Railway egress, a DNS
issue at Railway, or a regional Aeropay POP). Open a ticket with
Railway in parallel with continuing this runbook.

### Step 2 — Flip the kill switch

The kill switch is the `PAYMENTS_ACCEPTING_NEW_CHARGES` flag in
GrowthBook, evaluated server-side in `PaymentService.preflightCharge`.
When `false`, `/v1/checkout` short-circuits with a 503 carrying:

```json
{
  "error": "PaymentProviderUnavailable",
  "code": "payments_paused",
  "userMessage": "Checkout is temporarily paused. Your cart is saved — we'll be back online shortly.",
  "retryAfter": 600
}
```

To flip it:

1. Open GrowthBook (`app.growthbook.io/dankdash`).
2. Find feature `payments.accepting_new_charges`.
3. Set to `false`. Add a note: `Aeropay outage YYYY-MM-DDTHH:MM ack-by <operator>`.
4. Save. Propagation is <30s.

Verify the kill switch is live:

```sh
curl -sS -X POST https://api.dankdash.com/v1/checkout \
  -H 'Authorization: Bearer <test token>' \
  -H 'Idempotency-Key: probe-killswitch-<ts>' \
  -d '{"cartId":"00000000-0000-0000-0000-000000000000"}'
# → 503 PaymentProviderUnavailable
```

### Step 3 — Communicate

Update the status page (`status.dankdash.com`, BetterStack) to
`Major Outage — Checkout` with the customer-facing line:

> Checkout is temporarily paused while we wait for our payments
> partner to come back online. Your cart is saved. Existing orders
> are unaffected.

Post in `#cs-alerts` so customer support knows the script. Post
in `#vendors` so dispensary owners know orders will resume
automatically when service returns.

Do **not** mention "Aeropay" by name in customer-facing channels —
say "our payments partner". Aeropay's outage is not the customer's
problem to debug, and naming a third party in a status notice
muddles the support narrative.

### Step 4 — Drain the in-flight queue

Some checkouts may have called Aeropay during the failure window
and timed out without recording a `provider_ref`. These show up
as:

```sql
SELECT id, cart_id, idempotency_key, created_at
  FROM payment_transactions
 WHERE status = 'pending'
   AND created_at > now() - interval '15 minutes'
   AND provider_ref IS NULL
 ORDER BY created_at ASC;
```

Each row needs an idempotent **status lookup**, not a retry:

```sh
pnpm --filter @dankdash/aeropay run reconcile-pending \
  --since '15 minutes ago' --env prod
```

The reconciler issues `GET /v1/charges?idempotency_key=<key>` for
each pending row. Outcomes:

- **Aeropay has it as `processing` or `settled`.** Update
  `payment_transactions.provider_ref` + `status` in place. Trigger
  the `order:payment_confirmed` event so the order moves forward.
- **Aeropay has no record.** Write `status='failed'`,
  `failed_reason='provider_unavailable_no_record'`, set the order
  to `paymentFailed`, fire the customer-facing notification.
- **Aeropay returns its own 5xx.** Leave the row. The reconciler
  re-runs every 5 minutes via the workers cron; it will clear
  once Aeropay is back.

**Do not retry checkouts manually.** A manual retry that does not
share the idempotency key with the original attempt is the
double-charge path. The reconciler is the only correct tool.

### Step 5 — Monitor recovery

Watch:

- `aeropay_health_total{result="ok"}` — should return to baseline.
- `payment_transactions` rate of `pending → processing` per minute
  — should climb after the kill switch is released in Step 6.
- The Aeropay status page — wait for the **resolved** badge plus
  one of (a) our synthetics green for 5 minutes, or (b) Aeropay's
  written all-clear in `#aeropay-incidents`.

### Step 6 — Restore service

When the upstream is recovered:

1. Flip `payments.accepting_new_charges` back to `true` in
   GrowthBook. Add a recovery note with the duration.
2. Update the status page to `Operational`. Post a brief recovery
   message: "Checkout is back online. We've reconciled any
   in-flight orders — if you saw a 'paused' message during the
   incident, your cart is still there."
3. Run the reconciler one more time:
   ```sh
   pnpm --filter @dankdash/aeropay run reconcile-pending \
     --since '2 hours ago' --env prod
   ```
   This catches any rows that were pending at the moment the
   kill switch flipped but cleared after Aeropay came back.
4. Acknowledge resolved in PagerDuty.

## Rollback / fallback

There is no fallback to a second processor. Aeropay is the only
cannabis-rails ACH provider integrated. **Do not attempt to route
payments through a Visa/Mastercard merchant account** — the
underwriting agreements on every consumer credit-card network
forbid cannabis transactions, and a single charge run on those
rails is enough to terminate the merchant account permanently and
expose the operator to fraud-claim chargebacks with no recourse.

If Aeropay is down for >24h, the business decision is to keep
checkout paused or to manually onboard cash-on-delivery (which
requires OCM regulatory approval and physical-cash chain-of-custody
procedures that are not in scope for v1). Escalate to the CEO.

## Customer impact bounds

- **Customers without an active order**: shown the paused-checkout
  banner. Their cart persists for 24h. No financial impact.
- **Customers with a `placed` order and `pending` payment** during
  the outage: the reconciler in Step 4 resolves these. If Aeropay
  has the charge, the order continues. If Aeropay does not, the
  order moves to `paymentFailed` and the customer is refunded
  any pre-auth (no funds moved if Aeropay has no record).
- **Customers with `accepted` or later orders**: unaffected.
  Their charge was already accepted by Aeropay; settlement is
  delayed but final.
- **Customers receiving deliveries during the outage**: unaffected.
  Delivery proceeds normally on already-charged orders.

## Postmortem template

After the all-clear, file under `docs/incidents/aeropay/YYYY-MM-DD.md`:

- **Detection** — which signal fired first, how long from upstream
  failure to our PagerDuty page.
- **Timeline** — kill switch on, status page updated, queue
  reconciled, kill switch off.
- **Customer impact** — count of orders blocked at checkout,
  count of orders moved to `paymentFailed`, total dollar value
  blocked, percent of normal-window orders affected.
- **Reconciliation gaps** — any rows the reconciler could not
  resolve cleanly (manual ledger entries needed).
- **Upstream cause** — copy of Aeropay's RFO when published.
- **Followups** — synthetic check changes, alert threshold
  adjustments, comms template improvements.

Open Linear tickets for each followup. Reference this file from
the parent incident ticket.
