# Veriff API key + webhook secret rotation

## When to rotate

- **Suspected compromise of `VERIFF_API_KEY` or
  `VERIFF_WEBHOOK_SECRET`.** Treat as P0; rotate immediately. A
  compromised webhook secret lets an attacker forge "approved" KYC
  decisions on arbitrary orders, which would let an unverified
  recipient receive cannabis — an existential compliance failure.
- **Annual cadence.** Rotate every 12 months alongside the JWT and
  password-pepper rotations.
- **Personnel change with secret access.** Rotate after any operator
  with knowledge of the previous secret leaves the team.
- **Vendor-driven rotation.** Veriff occasionally requires customers
  to roll a secret as part of platform updates; the procedure is the
  same.

The API key is sent on every outbound request to Veriff
(`X-AUTH-CLIENT` header in `VeriffClient.createSession` /
`getDecision`). The webhook secret HMACs every outbound request body
**and** verifies every inbound webhook delivery. Veriff treats both
as a single tenant credential — the dashboard issues the API key
once and exposes the matching secret next to it.

## Mechanism

Veriff supports a single active credential pair per integration; the
dashboard does not offer dual-credential overlap. Rotation therefore
proceeds in three coordinated phases instead of the
mint-old-and-new-in-parallel pattern used for JWT keys:

1. **Drain** outbound calls to a quiescent state — finish in-flight
   `createSession` and `getDecision` requests, then stop minting new
   ones for the rotation window.
2. **Swap** the credential in the Veriff dashboard and Railway secret
   store, simultaneously.
3. **Resume** outbound calls. Inbound webhooks delivered between the
   swap moment and our service picking up the new secret are
   automatically retried by Veriff (24h retry window, exponential
   backoff).

The compliance gate at delivery never depends on a non-quiescent
session — a session is either pending (driver paused / iOS polling),
approved (delivery proceeds), or declined / resubmission (driver
restarts the scan). The drain window blocks only **new** session
creation, which the iOS client gracefully handles by surfacing
"verification temporarily unavailable" with a single retry.

A 5-minute drain window is the operational sweet spot: long enough
that the slowest in-flight Veriff request (p99 ~3s) completes, short
enough that the driver-facing impact is one minute of "Try again in
a moment" UX.

## Procedure

The procedure assumes a healthy production deployment with
observability that can graph:

- `veriff.session.created_total` and `veriff.session.created_errors`
- `veriff.decision.fetched_total` and `veriff.decision.fetched_errors`
- `veriff.webhook.delivered_total` by `outcome` (verified | rejected)
- `kyc.gate.checked_total` by `result` (allowed | blocked)

### Step 1 — Confirm baseline + announce maintenance window

Open the Grafana panel "ID verification — Veriff" and confirm the
four series above are at their normal-hours rate (typically
10–30/min for `session.created`, 5–15/min for `webhook.delivered`).

Post in the on-call channel:

> Beginning Veriff credential rotation at `<UTC time>`. ID
> verification will be paused for up to 5 minutes. Drivers will see
> "Verification temporarily unavailable, retry in a moment" on
> orders that hit the gate during this window. Inbound webhooks
> will retry automatically.

If the rotation is in response to compromise, additionally page the
compliance officer — the rotation window doubles as the incident's
containment moment.

### Step 2 — Generate the new credential in Veriff

Sign in to the Veriff Station dashboard with the operator's named
account (not a shared role account). In **Integrations → API
credentials**:

1. Note the current API key + secret values (you will need them for
   the rollback path).
2. Click **Rotate credentials**. Veriff displays the new API key and
   the new secret — both are shown once and never again.
3. Copy both values into a password-manager entry tagged
   `veriff-rotation-<YYYYMMDD>`. The entry expires in 7 days; the
   manager auto-shreds.

Do not click **Confirm rotation** in the Veriff dashboard yet — that
step invalidates the previous credential. The dashboard pre-shows
the new credentials so the operator can stage them in Railway
**before** flipping the cut-over.

### Step 3 — Drain outbound calls

Set the kill-switch in Railway env vars on the `api` service:

```
VERIFF_KILL_SWITCH=true
```

`VeriffClient` honors this flag — `createSession` and `getDecision`
short-circuit with `KycError(KYC_TEMPORARILY_UNAVAILABLE)` and the
controller returns a 503 with the `retryAfter` header set to 60s.
The iOS client treats 503 as a retriable error and waits.

Apply the env var and let Railway redeploy. Wait 90 seconds after
the redeploy completes — long enough for any pre-redeploy in-flight
session creates to finish (p99 ~3s, padded ×30).

Confirm `veriff.session.created_total` rate falls to zero on the
Grafana panel.

### Step 4 — Swap the credential

**On the Veriff dashboard:**

Click **Confirm rotation**. The previous credential is invalidated.
From this moment until Step 5 completes, no service can talk to
Veriff successfully.

**On Railway, on the `api` service:**

1. Replace `VERIFF_API_KEY` with the new value from Step 2.
2. Replace `VERIFF_WEBHOOK_SECRET` with the new value from Step 2.
3. Remove `VERIFF_KILL_SWITCH` (or set it to `false`).

Apply all three changes atomically — Railway batches the
environment update and triggers a single redeploy. Do not redeploy
between Step 2 and Step 4; doing so opens a window where the
previous credential is still authoritative on our side but the new
one is authoritative on Veriff's.

### Step 5 — Verify resumption

Within 30 seconds of the redeploy completing:

1. `veriff.session.created_total{result="ok"}` should return to
   baseline rate.
2. `veriff.webhook.delivered_total{outcome="verified"}` should
   resume — Veriff has been retrying webhooks delivered during the
   drain window, and they will now verify against the new secret.
3. `veriff.webhook.delivered_total{outcome="rejected"}` must be
   close to zero (a single rejection within the first 60 seconds
   is acceptable — Veriff occasionally re-delivers a webhook that
   was signed with the previous secret if it was in flight at the
   swap moment; after the first minute, every webhook is signed
   with the new secret).

Run an end-to-end smoke test:

```sh
# From a staging driver account, against staging Veriff:
curl -X POST "https://api.staging.dankdash.com/v1/driver/orders/${ORDER}/id-scan-session" \
  -H "Authorization: Bearer ${DRIVER_TOKEN}" \
  -H "Content-Type: application/json"
```

The response must be 201 with `verificationId` populated. Open the
Veriff session URL in a browser, complete the scan in test mode
(Veriff sandbox supports auto-approve), and confirm the webhook
verifies on our side (Grafana panel `veriff.webhook.delivered_total{outcome="verified"}`
ticks).

### Step 6 — Announce completion

Post in the on-call channel:

> Veriff credential rotation complete at `<UTC time>`. ID
> verification is fully restored. End-to-end smoke test passed.

Shred the password-manager entry from Step 2 — the previous
credential is now permanently inaccessible.

## Rollback

The rollback path depends on **when** the rotation fails:

**During Step 3 (drain failed to take effect):**

If `VERIFF_KILL_SWITCH=true` does not stop `session.created`
traffic within 60 seconds, the env var did not propagate. Force a
redeploy via `railway redeploy --service api`. Do not proceed to
Step 4 until traffic is quiescent — flipping the dashboard
credential while requests are in flight will produce a brief storm
of `KYC_INQUIRY_FAILED` 5xx errors.

**Between Step 4 (Veriff dashboard) and Step 4 (Railway):**

This is the most painful window. Veriff has already invalidated
the previous credential; Railway has not yet picked up the new
one. Every Veriff call will fail with `401`. Force the Railway
update through faster — use `railway variables set` from the CLI
rather than waiting on the dashboard UI; the API responds to env
changes within ~20s of the apply.

If the Railway update itself fails (rate-limit, validation error),
**re-issue the credentials** from the Veriff dashboard rather than
trying to recover the previous pair. Veriff allows a re-rotation
back-to-back; the operator picks up a third credential pair and
loads it into Railway, then Step 5.

**After Step 5 (smoke test failed):**

Common causes:

- _New webhook secret was pasted into `VERIFF_API_KEY` and
  vice-versa._ The smoke test will fail at session-create (401
  from Veriff). Swap the two env vars and redeploy.
- _Trailing newline in the base64 paste._ `VeriffClient` accepts
  the secret verbatim; a stray `\n` corrupts the HMAC. Re-paste
  with newline stripped: `tr -d '\n' < secret.txt`.
- _Veriff dashboard state lagged._ Wait 60 seconds, retry. If
  still failing, contact Veriff support with the rotation
  timestamp.

If the rollback path is exhausted, the failure mode is **delivery
verification is unavailable for the duration of the incident**.
This is not a security failure — orders cannot be marked delivered
without verification, so the safety-critical contract is intact —
but driver earnings and order completion are paused. Page the
compliance officer to declare an operational incident; do not
attempt to bypass the verification gate to clear the backlog.

## Coordinating outbound webhook receipts

Veriff signs every webhook delivery with the secret active at
**send time**, not receive time. A webhook minted before the swap
and delivered after the swap will fail signature verification —
Veriff handles this by exponential-backoff retrying for 24h.

During Step 5 you may see a brief window (the first minute after
swap) where `veriff.webhook.delivered_total{outcome="rejected"}`
shows non-zero counts as Veriff retries previously-mid-flight
deliveries. These are not security failures and do not require
investigation — they auto-resolve as Veriff's retry queue exhausts
its pre-swap entries.

If `outcome="rejected"` persists past 5 minutes, that **is** a
problem: it means either Veriff is signing with a different secret
than we configured, or we configured a different secret than
Veriff issued. Re-verify Step 2's password-manager entry against
Step 4's Railway env var character-for-character.

## Why no overlap window like JWT rotation

JWT rotation supports a kid-indexed dual-key verify path because
**we** control both ends — our signer and our verifiers. With
Veriff, the credential is shared with an external party that does
not support dual-credential overlap. The drain-swap-resume
procedure is the operational equivalent: a brief outage instead of
a brief dual-state.

The trade-off is acceptable because ID verification is a
high-latency operation already (driver scans an ID, Veriff renders
a decision in 3–10s, the iOS client polls). A 5-minute pause on
**new** session starts is invisible to drivers who are mid-scan
and produces a single "retry in a moment" UX moment for drivers
who would have started a scan during the window.

## Postmortem template

After every rotation, file an entry under
`docs/security/key-rotation-log.md` (shared with the JWT rotation
log) with:

- Date / operator / reason (annual | compromise | personnel-change |
  vendor-required)
- Drain window duration (target: ≤5 min)
- Webhook rejection count during the rollover (expected: ≤10)
- Anomalies (any service that did not respect the kill-switch? any
  iOS client that escalated past the 503 retry?)
- Whether the previous credential was confirmed destroyed (cannot
  be recovered from Veriff dashboard history; the password-manager
  entry from Step 2 was shredded in Step 6)

If the rotation was triggered by suspected compromise, file an
incident report in `docs/security/incidents/` referencing this
entry. For Veriff specifically, include: which orders had
verifications attributable to the compromised secret window (query
`orders.compliance_check_payload->>'veriffSessionId'` against the
log of Veriff deliveries received in that window), whether any
order was marked delivered against a forged "approved" decision
(query `order_events` for `delivery_confirmed` events with no
matching genuine Veriff record), and the notification posture to
Minnesota OCM if any non-verified delivery occurred.
