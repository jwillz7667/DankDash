# Driver app crash spike

## Purpose

If the DankDasher iOS app crashes on a meaningful fraction of
shifts, drivers go offline, deliveries stall, and orders pile up
in `awaitingDriver` until a customer-facing SLA breach. Crash
spikes on the driver fleet are operationally worse than crashes
on the consumer app — there is no "try again later" for a driver
mid-delivery — so the response is faster and more aggressive
about pulling the bad build.

This runbook covers a crash-spike incident: how to detect it,
how to determine whether to force a downgrade, how to compensate
the dispatch queue while the fleet is unstable, and how to roll
forward when the fix lands.

## When to fire

- **Sentry crash-free-sessions drop.** Alert
  `DankDasherCrashFreeBelowThreshold` fires when crash-free
  sessions on the DankDasher target falls below 99% for >15
  minutes, scoped to the latest TestFlight or App Store build.
  PagerDuty page.
- **Active driver count drop.** The
  `DriverActiveCountDropped` Grafana alert fires when active
  driver count (as reported by the realtime shift heartbeat)
  drops >25% in a 10-minute window without a corresponding
  decline in dispatch demand. This is the leading indicator —
  it usually fires before Sentry can build a crash-rate stat.
- **Driver support ticket burst.** If `#driver-support` Slack
  inbound rate jumps and tickets cluster on "app keeps closing"
  / "won't open" / "frozen", that is functional evidence
  regardless of what Sentry shows. Trust the humans over the
  telemetry; the telemetry may itself be downstream of the
  crash.

## Background

### The DankDasher fleet

- TestFlight only (we are pre App Store at v1.0). All drivers
  are on a managed device list; build distribution is via Apple
  Business Manager.
- Crash reports flow to Sentry via the
  `@sentry/react-native` equivalent — `Sentry.Apple` SDK
  initialized in `DankDasher/Core/Observability/SentryBootstrap.swift`.
- Symbolication: dSYM uploaded as part of the CI release job.
  Crashes from un-symbolicated builds will show only the
  binary offset; force a re-upload by hand if a build is in
  this state.
- The driver shift state lives in `driver_shifts` (server) +
  the on-device `Shifts` SwiftData store. A crash kills the
  shift heartbeat; the server marks the driver `offline` after
  90 seconds of missed pings.

### Build channels

- `internal` — engineers + QA. Daily builds.
- `pilot` — handful of friendly drivers. Gets the staging build
  before production drivers see it.
- `production` — full fleet. Updated weekly or on hotfix.

A crash spike on `internal` is a build issue, page once.
A crash spike on `pilot` means the next production build will
crash too — pull the pilot build before it goes wide.
A crash spike on `production` is the scenario this runbook
mostly cares about.

### Force-update gate

`apps/api/src/features/driver/app-version.controller.ts` exposes
`/v1/driver/app-version-policy` which the app calls on launch
and on every shift start. The response shape:

```json
{
  "minSupportedBuild": 142,
  "currentBuild": 150,
  "forceUpgradeBelow": 145,
  "message": "Please update DankDasher to continue.",
  "downloadUrl": "https://testflight.apple.com/join/<code>"
}
```

`forceUpgradeBelow` is the kill-switch knob. Setting it to a
value `> bad_build` pushes a blocking update prompt to every
driver on a bad build. The app refuses to start a shift until
the update completes.

`minSupportedBuild` is the harder cutoff — the app refuses to
**run at all** below this. We do not flip `minSupportedBuild`
during an incident because the fix is to push drivers off the
bad build, not to brick their app entirely.

## Procedure

### Step 0 — Acknowledge

Acknowledge PagerDuty. Set `#incidents` status:
`🚨 Driver app crash spike — investigating`. Tag
`@dispatch-on-call` immediately — they will be coordinating the
fleet while engineering investigates.

### Step 1 — Confirm scope

Open the DankDasher Sentry release-comparison view. Capture:

- **Affected build number(s).** Often a single build, sometimes
  the last two if the crash is in a shared dependency.
- **iOS version distribution.** A crash only on iOS 17.6 is a
  very different bug from a crash on all iOS versions.
- **Affected screen / flow.** Stack trace at top usually names
  the SwiftUI view, the ID-scan SDK callback, or the realtime
  client.
- **First seen.** When did the spike begin? Lines up with which
  build went out via TestFlight?

If only one build is bad and the fleet has not fully picked it
up yet, go straight to Step 2 (downgrade gate). If multiple
builds are affected, you have a server-side or backend-data
issue — see Step 3.

### Step 2 — Stop the bleed: force-downgrade gate

If the bad build is identifiable:

```sh
pnpm --filter @dankdash/api exec -- \
  driver-version-policy set \
    --force-upgrade-below <bad_build_number + 1> \
    --message "We've detected an issue with this build. Please update to keep driving." \
    --download-url "<testflight-fallback-build-url>"
```

This makes the next "start shift" attempt by an affected driver
return a 426 (Upgrade Required) and force the app to display
the upgrade prompt. The fallback TestFlight URL must point at
the **last-known-good build**, not the broken one.

Verify the gate is live:

```sh
curl -sS https://api.dankdash.com/v1/driver/app-version-policy \
  -H 'Authorization: Bearer <driver-test-token>'
# → should show forceUpgradeBelow >= bad_build + 1
```

### Step 3 — Investigate if no single build is the cause

If the crash spans builds, the trigger is something the app sees
from outside itself. Most common:

- **Server response shape change.** A backend deploy changed the
  shape of `/v1/driver/offer/...` or `/v1/driver/shift/...` and
  the app's Codable decoder is rejecting the new field. Look
  at recent api deploys; the crash time-correlates with one of
  them.
- **Realtime payload change.** A new Socket.io event the app
  cannot parse. Same root cause; same investigation.
- **Background-task data corruption.** Local SwiftData store
  has a bad row that the app crashes on read. Affects only
  drivers whose device has that row — confirm by checking the
  per-driver crash distribution; corruption clusters on
  specific user IDs.

For the first two, **roll back the api deploy** (see
`docs/runbooks/high-order-error-rate.md` Path E). The app's
crash recovers automatically on the next launch.

For the third, ship a hotfix that wraps the corrupted-read with
a tolerant decoder and treats failures as "skip the row." This
is engineering work, not an operator runbook step.

### Step 4 — Compensate the dispatch queue

While the fleet is degraded, orders accumulate in
`awaitingDriver`. The dispatcher's job is to keep customers from
hitting SLA violations.

Capture the current queue snapshot:

```sql
SELECT id, dispensary_id, created_at,
       EXTRACT(EPOCH FROM (now() - placed_at)) / 60 AS minutes_pending
  FROM orders
 WHERE status = 'awaitingDriver'
 ORDER BY placed_at ASC
 LIMIT 50;
```

For each row over 30 minutes pending:

1. **Try to reassign.** Most other drivers on the good build
   are still online; the dispatcher reassigns through the
   normal admin tool.
2. **If no driver in geofence is available**: phone the
   customer with the script
   `docs/runbooks/templates/delayed-delivery-call.md`. Offer:
   - Continue waiting (typical delay 30–60 min beyond ETA).
   - Cancel with full refund.
   - 20% credit on next order if they keep waiting.
3. **If the dispensary cannot hold the order safely** (chain of
   custody requires the order in the dispensary's possession
   not to exceed 4 hours from prep), return-to-store the order.

Log the dispatcher actions in `#incidents` so the postmortem
has the customer-impact record.

### Step 5 — Communicate

Internal:

- `#drivers` channel — pinned message: _"We've identified an
  issue with the latest DankDasher build. Please update via
  TestFlight when prompted. If you can't start a shift, please
  hold and we'll DM you the moment a fix is ready."_
- `#cs-alerts` — customer support script for inbound "where is
  my order" calls.
- `@dispatch-on-call` — confirm the compensation actions in
  Step 4 are running.

External:

- No customer-facing status page entry unless deliveries are
  failing. We do not name the driver-side issue to customers;
  customers see only their order status, which the dispatcher
  is managing in Step 4.

### Step 6 — Roll forward

When the fix is built and the new build is in TestFlight:

1. Bump `currentBuild` and `minSupportedBuild` policy so the
   new build is the recommended one and the bad one is below
   the minimum:
   ```sh
   pnpm --filter @dankdash/api exec -- \
     driver-version-policy set \
       --current-build <new_build> \
       --min-supported-build <new_build>
   ```
2. Watch crash-free sessions return to ≥99.5%.
3. Once stable for 30 minutes, release the gate (no more
   `force-upgrade-below` need to be set; the app's `currentBuild
< minSupportedBuild` check carries it).
4. Resolve PagerDuty.

## Pre-incident hardening

Things to check periodically so this runbook is rarer:

- Sentry release-health alert thresholds — re-tune quarterly.
- TestFlight pilot ring — at least 5 active drivers, distinct
  iPhones, opted into pilot.
- The api `app-version-policy` is in the smoke test suite — a
  bad deploy that breaks it would lock out the entire fleet.
- The `driver-version-policy` CLI command is exercised in the
  staging environment monthly so the operator playbook stays
  fresh.

## Postmortem template

Under `docs/incidents/driver-app/YYYY-MM-DD.md`:

- **Detection** — which signal fired, time from first crash to
  PagerDuty page.
- **Bad build identification** — when, by whom.
- **Fleet impact** — peak driver-offline count, total minutes
  of degraded capacity.
- **Customer impact** — orders delayed past SLA, credits
  issued, customer-cancel count.
- **Root cause** — the bug in the app or the data drift from
  backend.
- **Fix path** — hotfix build vs. backend rollback.
- **Followups** — additional Sentry alerts, pilot-ring
  expansion, automated rollback policy on crash-rate breach.
