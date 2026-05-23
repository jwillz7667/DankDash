# Metrc API failure

## Purpose

Metrc is the Minnesota OCM seed-to-sale tracking system. Every
delivered cannabis order has to be reported to Metrc, with the
package tag(s) drawn from the dispensary's allocated inventory.
Reporting is **post-facto** — we deliver first and report after —
which means a Metrc outage is materially different from an Aeropay
outage: the customer can still get their order, but we have a
**regulatory clock** that starts the moment Metrc rejects or
drops a report.

This runbook is the operator playbook when Metrc is unreachable,
returning 5xx, or rejecting valid receipts. The compliance and
legal posture here is the dominant constraint, not the technical
one.

The companion code:

- `packages/metrc/` — the Metrc API client (OAuth, per-license
  facility scoping, request signing).
- `apps/workers/src/jobs/metrc-emit.cron.ts` — fires on every
  `order.delivered` event, builds the receipt payload, posts to
  Metrc. Failures enqueue a retry on the `metrc-retry` BullMQ
  queue with exponential backoff (5min → 15min → 1h → 4h → 24h).
- `apps/workers/src/jobs/metrc-reconcile.cron.ts` — nightly
  03:30 America/Chicago, compares our `metrc_receipts` table
  against Metrc's daily transfer ledger, flags drift.
- `apps/api/src/features/compliance/metrc-status.controller.ts`
  — exposes `/v1/admin/metrc/status` so the back office can see
  the queue depth and the last successful emission per dispensary.

## When to fire

- **Synthetic check failed.** `metrc-health` probe in
  `apps/workers` calls `GET /v1/facilities` every 5 minutes with
  the shared service license. Three consecutive failures fires
  `MetrcHealthDown` → PagerDuty.
- **`metrc-retry` queue depth alert.** Grafana
  `MetrcRetryQueueElevated` fires when queue depth > 100 messages
  for >15 minutes. This is the typical first signal of a real
  outage because the synthetic only checks `/v1/facilities`,
  which Metrc sometimes keeps serving while write paths fail.
- **Per-license rejection rate spike.** Some Metrc failures are
  scoped to a single dispensary's API key (license suspended,
  key rotated server-side, facility scoping mismatch). The alert
  `MetrcLicenseRejectionBurst` fires when one license sees ≥5
  401/403 rejections in 15 minutes — this is **not a Metrc
  outage**, it is a dispensary-specific issue; jump to the
  dispensary path below.
- **Metrc status page advisory.** `status.metrc.com` posts
  state-segmented advisories. A Minnesota advisory subscribed
  via RSS in BetterStack auto-pages.

If the signal is broad (queue depth + synthetic + status page),
treat as full outage. If the signal is narrow (one license, one
endpoint), treat as targeted and skip the customer-comms steps.

## Background

### What a Metrc submission looks like

Each `order.delivered` event triggers:

1. **Build the receipt.** Per-line: `package_tag`, `quantity`,
   `unit_of_measure`, `unit_thc_content`, `delivery_id`. Header:
   `dispensary_license`, `customer_dob_hash`, `delivery_timestamp`,
   `driver_license_number_hash`, `geofence_zone`.
2. **Sign + post.** `POST /v1/sales/receipts/active` with the
   dispensary's per-facility API key. Idempotency comes from
   the `external_id` field which we set to `order.id`.
3. **Persist.** On 200, write a row to `metrc_receipts` with the
   returned Metrc receipt id and the timestamp. On 4xx with a
   structured error, classify it (see "rejection classes" below)
   and decide retry vs. escalate. On 5xx, retry.

The retry policy intentionally caps at 24 hours because Minn.
Rule 21-23 expects reporting within 24h of sale; missing that
window does not invalidate the sale (we already delivered), but
it creates an OCM-visible reporting gap.

### Rejection classes

| Code                  | Cause                                           | Action                                                 |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `5xx` / network       | Metrc outage or transient                       | Retry with backoff, escalate at 24h                    |
| `401` / `403`         | API key invalid for facility                    | Pause that dispensary's emissions, ping the dispensary |
| `422 INVALID_TAG`     | Package tag not in dispensary's inventory       | Pause, escalate to dispensary — POS sync issue         |
| `422 STALE_PACKAGE`   | Tag was active when sold, voided in Metrc since | Manual correction with OCM, do not auto-retry          |
| `422 LICENSE_EXPIRED` | Dispensary license lapsed                       | **Stop emissions for that license**, escalate to CEO   |
| `409 DUPLICATE`       | Receipt already submitted                       | Treat as success — write the existing receipt id       |

`409 DUPLICATE` is the friend, not the enemy — it means our
idempotency key did its job and Metrc has the record. The cron
treats it as a soft-success path.

## Procedure

### Step 0 — Acknowledge

Acknowledge PagerDuty. Set Slack status in `#incidents`:
`🚨 Metrc outage — investigating`. Tag `@compliance` and
`@legal-counsel-on-call` early — they may need to file a notice
with OCM if this exceeds 24 hours.

### Step 1 — Confirm

```sh
# Health probe (read path)
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <service-key>" \
  https://api-mn.metrc.com/v1/facilities

# Write-path canary — try a deliberately-bad receipt to exercise
# auth + routing without polluting the ledger. Expect 422.
pnpm --filter @dankdash/metrc run probe -- --env prod --license <shared-svc>
```

If reads pass but writes 5xx, this is the partial-outage
pattern. Skip to Step 3 — write-path retry handling is the
operator's job until Metrc declares the all-clear.

### Step 2 — Inspect the queue

```sh
pnpm --filter @dankdash/workers exec -- bullmq inspect metrc-retry --env prod
```

Capture:

- Queue depth at this moment (baseline is <20).
- Age of the oldest message (the regulator clock starts at the
  delivery timestamp inside that message, not at queue entry).
- Distribution by license — is one dispensary blowing up the
  queue, or is it across the board?

Save to `/tmp/metrc-queue-<timestamp>.json`. This becomes the
"before" snapshot for the postmortem.

### Step 3 — Decide: drain, hold, or stop

Three postures. **Choose explicitly** and announce in `#incidents`:

- **DRAIN.** Let the retry queue keep running. Right call for a
  short outage (<2h). Backoff handles everything.
- **HOLD.** Pause the retry consumer manually so we do not burn
  through retry budget against a known-down upstream. Right
  call for a confirmed multi-hour outage. Resume in Step 6.
  ```sh
  pnpm --filter @dankdash/workers exec -- \
    bullmq pause metrc-retry --env prod --note 'Metrc outage'
  ```
- **STOP.** Set `metrc.emission_paused` in GrowthBook to `true`.
  This bypasses the emit step entirely — orders still deliver,
  but no receipt is built and no queue entry is created. Receipts
  for the affected window are rebuilt from `orders` + `order_items`
  in Step 6. **Only choose this if the outage is multi-day** —
  otherwise the rebuild work is more expensive than the retry
  queue.

### Step 4 — Communicate

Internal:

- `#vendors` — dispensaries should know their nightly Metrc sync
  is delayed. Use language like: _"Metrc reporting is queued
  while we wait for the system to come back. Deliveries continue
  normally; your dashboard will catch up automatically. No
  action needed."_
- `@compliance` — the compliance team owns the OCM relationship.
  Pre-draft the OCM notice now even if you may not have to send
  it (template at `docs/legal/templates/ocm-metrc-outage-notice.md`).

External (only if outage > 4h):

- Customer-facing status page: do not mention Metrc by name in
  the user-facing line. Customer impact at this layer is zero.
  Mention only if asked.

### Step 5 — Watch the clock

Compliance escalation thresholds, measured from the delivery
timestamp of the **oldest queued** receipt:

| Elapsed     | Action                                                             |
| ----------- | ------------------------------------------------------------------ |
| 0–4 hours   | Queue + retry. No external action.                                 |
| 4–12 hours  | Notify `@compliance` formally. Pre-draft OCM letter.               |
| 12–20 hours | Compliance officer calls OCM duty desk. Escalate inside Metrc.     |
| 20–24 hours | File OCM "delayed reporting" notice via the standard template.     |
| >24 hours   | OCM compliance violation; legal counsel takes lead on remediation. |

The clock does not pause for nights or weekends. A 23:00 delivery
that fails to report by 23:00 the next day is a violation
regardless of which day of the week it falls on.

### Step 6 — Recover

When Metrc comes back:

1. **If you HOLDED the queue:** resume it.
   ```sh
   pnpm --filter @dankdash/workers exec -- \
     bullmq resume metrc-retry --env prod
   ```
   Watch queue depth drain.
2. **If you STOPPED emissions:** rebuild the missing window.
   ```sh
   pnpm --filter @dankdash/workers exec -- \
     metrc-backfill --since '<outage-start-iso>' --env prod
   ```
   The backfill scans `orders` for the window where
   `status='delivered'` and no `metrc_receipts` row exists,
   reconstructs the receipt payload from the order snapshot,
   and pushes to Metrc with the original `delivery_timestamp`.
   Then flip `metrc.emission_paused` back to `false`.
3. **Verify**: every order in the outage window has a
   `metrc_receipts` row.
   ```sql
   SELECT o.id, o.delivered_at
     FROM orders o
   LEFT JOIN metrc_receipts r ON r.order_id = o.id
    WHERE o.status = 'delivered'
      AND o.delivered_at BETWEEN '<outage-start>' AND '<outage-end>'
      AND r.id IS NULL;
   -- → should return zero rows
   ```
4. Acknowledge PagerDuty resolved.
5. Reverse any OCM filing if the resolution closed within the
   24-hour window before regulator action was triggered.

## Per-dispensary failure path (not a full outage)

If `MetrcLicenseRejectionBurst` fires for a single license:

1. Pause that dispensary's emissions only:
   ```sh
   pnpm --filter @dankdash/api exec -- \
     dispensary-tool metrc-pause <license> --reason 'reject-burst'
   ```
2. Pull the rejected receipt payloads. Most common cause: their
   POS rotated package tags but did not push the update to us.
3. Contact the dispensary owner. Use the script in
   `docs/runbooks/templates/dispensary-metrc-mismatch.md`.
4. Once they confirm the tags are reconciled in their POS,
   resume emissions and let the queue drain.

Never globally pause emissions for a per-license failure. Other
dispensaries are unaffected and they need their reports out.

## Rollback / fallback

There is no fallback to a second tracking system. Metrc is the
state-mandated source of truth; no other vendor is recognized by
OCM. If Metrc is unavailable for an extended window, the legal
posture is to (a) file the delayed-reporting notice, (b) maintain
our internal `order_events` audit log as the substitute trail,
and (c) submit the full backlog once Metrc returns. Our
`order_events` rows are immutable and timestamped — they
constitute the audit-trail evidence regardless of whether Metrc
received them at the time of sale.

## Postmortem template

Under `docs/incidents/metrc/YYYY-MM-DD.md`:

- **Detection** — which signal fired, time-to-page.
- **Posture chosen** — drain | hold | stop, and rationale.
- **Compliance clock** — start (oldest queued delivery), threshold
  crossings (4h, 12h, 24h), OCM contact log if any.
- **Queue depth** — at firing, at peak, at recovery.
- **Rebuild scope** — count of orders backfilled if STOP was used.
- **Per-dispensary impact** — which licenses were behind, by how
  long.
- **OCM communication** — what was sent, when, response.
- **Followups** — synthetic improvements (write-path canary?),
  alert tuning, comms template updates.
