# DankDash Launch Checklist

This checklist enumerates every gate that must be cleared
before DankDash accepts its first real consumer order in
Minnesota. It is **not** a "Phase 22 is done" checklist —
it is the gate to "we have a live production system serving
real customers." Items here may depend on phases that have
not yet been written; their presence here is intentional.

## How to use this document

- Each section has an **Owner**, a **Definition of Done**,
  and a checklist of concrete items.
- The launch-readiness review walks this document
  top-to-bottom and confirms every box.
- A box may be marked complete only when the underlying
  artifact exists, has been tested, and a named human
  signs off.
- "Sign-off" means a human attaches their name and the
  current date to the box: `- [x] [item] — signed: J.
Williams 2026-05-22`.
- Do not pre-check boxes. Do not skip boxes "because we
  trust X" — the point of the checklist is that we do not
  rely on memory.

The launch decision is gated on **all eleven sections**
being signed off:

| #   | Section                        | Owner              |
| --- | ------------------------------ | ------------------ |
| 1   | Legal & regulatory             | Legal / Compliance |
| 2   | Secrets & environment          | Platform           |
| 3   | Third-party provisioning       | Platform           |
| 4   | Compliance engine              | Compliance         |
| 5   | Identity & payments            | Platform           |
| 6   | iOS apps (consumer + driver)   | iOS lead           |
| 7   | Vendor portal & onboarding     | Web lead           |
| 8   | Observability & alerting       | SRE                |
| 9   | On-call & support              | Operations         |
| 10  | Marketing site & legal hosting | Web lead           |
| 11  | Final go / no-go meeting       | CEO                |

## 1. Legal & Regulatory

**Owner:** Outside counsel + internal compliance lead.

**Definition of Done:** No `[REVIEW WITH COUNSEL]` markers
remain unresolved in any document linked from a customer-,
driver-, or partner-facing surface.

- [ ] DankDash, Inc. is a Delaware corporation in good
      standing, foreign-qualified to do business in
      Minnesota.
- [ ] Registered Minnesota cannabis-business license issued
      by OCM is in hand. License number recorded in
      `infra/secrets/ocm-license.yaml` (encrypted).
- [ ] Metrc account is provisioned by OCM. API key issued.
- [ ] OCM-required surety bond is posted. Documentation in
      counsel's file.
- [ ] All Dispensary Partner agreements are
      counter-signed by at least 3 dispensaries (the
      launch-soft set). Counter-signature recorded in
      DocuSign.
- [ ] All launch Drivers (target 15+) have:
  - [ ] Signed the Driver Agreement via DocuSign.
  - [ ] Passed background check (Checkr or Onfido).
  - [ ] Furnished a current certificate of insurance with
        DankDash listed as additional insured.
  - [ ] Completed the in-app Compliance Handbook
        acknowledgement.
- [ ] Terms of Service published at `dankdash.com/legal/terms`
      with the `[REVIEW WITH COUNSEL]` markers removed.
- [ ] Privacy Policy published at `dankdash.com/legal/privacy`
      with the `[REVIEW WITH COUNSEL]` markers removed.
- [ ] Cannabis Compliance Disclosures published at
      `dankdash.com/legal/disclosures` with the
      `[REVIEW WITH COUNSEL]` markers removed.
- [ ] Apple App Store Privacy Label has been submitted in
      App Store Connect and matches `privacy-policy.md`
      section-by-section.
- [ ] Apple's cannabis-policy workaround is documented in
      the App Review Notes for the consumer app.
- [ ] State data-breach notification template for
      Minn. Stat. § 325E.61 is filed in
      `docs/compliance/breach-notice-template.md`
      `[FACT-CHECK — file not yet created]`.
- [ ] DPO (Data Protection Officer) is appointed (where
      required by GDPR) and named in the Privacy Policy.
- [ ] Each service-provider DPA is signed:
  - [ ] Aeropay
  - [ ] Veriff
  - [ ] Twilio
  - [ ] Checkr (or Onfido)
  - [ ] Sentry
  - [ ] AWS
  - [ ] Cloudflare
  - [ ] Linear
- [ ] Insurance policies bound:
  - [ ] General liability
  - [ ] Cyber liability
  - [ ] Cannabis product liability
  - [ ] Contingent commercial auto (the driver-supplemental
        policy referenced in Driver Agreement § 4.3)
  - [ ] D&O
- [ ] Tax registrations complete:
  - [ ] Minnesota cannabis excise tax under Minn. Stat. § 295.81
  - [ ] Minnesota sales tax
  - [ ] Federal EIN
  - [ ] Federal Form 8300 reporting process documented (for
        any cash sales > $10,000 — unlikely under ACH-only,
        but the process must exist if cash is ever accepted)

## 2. Secrets & Environment

**Owner:** Platform / Infra.

**Definition of Done:** Every required production secret
is set, validated at boot by the config loader, and rotated
on a documented schedule.

### 2.1 Environment variables

Each variable must be set in Railway production environment
and validated by `packages/config/src/env.ts` (`EnvSchema`,
backed by Zod) at process boot. The repo template documenting
production sources for every variable is `.env.production.example`
at the repo root.

**API (`apps/api`):**

- [ ] `DATABASE_URL` (Postgres, with PgBouncer)
- [ ] `DATABASE_REPLICA_URL`
- [ ] `REDIS_URL`
- [ ] `JWT_PRIVATE_KEY` (current)
- [ ] `JWT_PRIVATE_KEY_NEXT` (rotation candidate)
- [ ] `JWT_PUBLIC_KEY_PREVIOUS` (for grace-period validation)
- [ ] `PASSWORD_PEPPER` (current)
- [ ] `PASSWORD_PEPPER_PREVIOUS`
- [ ] `MASTER_ENCRYPTION_KEY` (wraps column keys; backed by
      Railway secret manager)
- [ ] `AEROPAY_API_KEY` / `AEROPAY_API_SECRET` / `AEROPAY_WEBHOOK_SECRET`
- [ ] `VERIFF_API_KEY` / `VERIFF_API_SECRET` / `VERIFF_WEBHOOK_SECRET`
- [ ] `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`
- [ ] `METRC_API_KEY` / `METRC_USER_KEY` / `METRC_STATE` (`MN`)
- [ ] `CHECKR_API_KEY` (or `ONFIDO_API_KEY`)
- [ ] `SENTRY_DSN`
- [ ] `GROWTHBOOK_API_KEY`
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`
- [ ] `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
- [ ] `WEB_BASE_URL` (`https://www.dankdash.com`)
- [ ] `CHECKOUT_BASE_URL` (`https://checkout.dankdash.com`)
- [ ] `APP_DEEP_LINK_HOST` (`app.dankdash.com`)
- [ ] `NODE_ENV=production`

**Realtime (`apps/realtime`):**

- [ ] `REDIS_URL` (Socket.io adapter)
- [ ] `JWT_PUBLIC_KEY` (for token validation)
- [ ] `STICKY_SESSION_KEY`
- [ ] `SENTRY_DSN`

**Workers (`apps/workers`):**

- [ ] All variables under API (workers re-use API config).
- [ ] `BULLMQ_PREFIX=prod`

**Vendor portal (`apps/portal`):**

- [ ] `DATABASE_URL` (read-only replica)
- [ ] `JWT_PUBLIC_KEY`
- [ ] `NEXT_PUBLIC_API_BASE_URL`
- [ ] `SENTRY_DSN`

**Marketing site (`apps/web` or static deploy):**

- [ ] `NEXT_PUBLIC_API_BASE_URL`
- [ ] No secrets — this surface is fully public.

**Checkout web (`apps/checkout-web`):**

- [ ] `DATABASE_URL` (read-only replica)
- [ ] `JWT_PUBLIC_KEY`
- [ ] `AEROPAY_PUBLIC_KEY`
- [ ] `SENTRY_DSN`

### 2.2 Rotation schedule

- [ ] JWT keys: rotated quarterly (next: [DATE]).
- [ ] Password pepper: rotated annually (next: [DATE]).
- [ ] Aeropay webhook secret: rotated semi-annually.
- [ ] Veriff webhook secret: rotated semi-annually.
- [ ] Master encryption key: rotated annually (next: [DATE]).
- [ ] All other API keys: rotated annually or on
      compromise.

Each rotation has a runbook (see `docs/runbooks/`).

### 2.3 Boot validation

- [ ] Config loader (`packages/config/src/env.ts`, `EnvSchema`)
      fails fast on missing or malformed values.
- [ ] `pnpm --filter @dankdash/api run env-check` exits 0 against
      the populated `.env.production`. The CLI runs the schema, then
      the production-strict overlay from `@dankdash/config`
      (`runAllChecks`): bans localhost / debug-tier log levels,
      checks JWT key-pair coherence, checks feature-flag/credential
      coherence, and enforces the Twilio-sender XOR. Exit code 2 means
      at least one rule failed; do not deploy until exit 0.

## 3. Third-party provisioning

**Owner:** Platform.

**Definition of Done:** Each third party has a production
account, production credentials, a signed contract, and a
validated end-to-end smoke test against production.

- [ ] **Metrc** — production credentials, test sale logged,
      receipt issued, reconciliation runbook verified.
- [ ] **Aeropay** — production merchant ID, $1 test
      transaction posted, ACH return processed, webhook
      delivered.
- [ ] **Veriff** — production session created with a real
      ID, pass and fail paths smoke-tested, webhook
      delivered.
- [ ] **Twilio** — production phone number procured, A2P
      10DLC campaign approved (US carrier requirement),
      test SMS delivered to a non-employee number.
- [ ] **Checkr (or Onfido)** — production credentials,
      test background check submitted and returned, FCRA
      consumer-disclosure flow verified end-to-end.
- [ ] **Sentry** — production project provisioned, source
      maps uploaded, alert routing to PagerDuty verified.
- [ ] **Cloudflare R2** — production buckets created
      (`prod-id-scans`, `prod-coas`, `prod-product-images`),
      lifecycle rules set per Privacy Policy Section 6.
- [ ] **AWS** (or other backup target) — encrypted backup
      bucket, cross-region replication enabled, restore
      tested per `disaster-recovery-restore.md`.
- [ ] **Railway** — production project provisioned, billing
      attached, SLA tier confirmed.
- [ ] **GrowthBook** — production environment, feature-flag
      kill-switches created (see Section 4.4).
- [ ] **PagerDuty** — service created, escalation policy
      configured, on-call rotation populated.
- [ ] **Linear** — production project + privacy / safety
      ticket templates configured.
- [ ] **App Store Connect** — production app record,
      provisioning profiles, push certificates (Apple
      Push Notification Service production cert).
- [ ] **DocuSign** — production account, templates uploaded
      for Vendor Agreement, Driver Agreement.
- [ ] **DNS** — `dankdash.com`, `www.dankdash.com`,
      `app.dankdash.com`, `api.dankdash.com`,
      `checkout.dankdash.com`, `dankdash.business`
      (vendor portal, registered via Vercel),
      `status.dankdash.com` all point at the right
      origins; TLS certs auto-issued and renewing.

## 4. Compliance engine

**Owner:** Compliance.

**Definition of Done:** Every Minn. Stat. § 342.27 limit
is enforced by the server, tested against legitimate-pass
and legitimate-fail fixtures, and re-runs inside the
checkout transaction.

- [ ] Per-transaction limits (56.7g flower, 8g concentrate,
      800mg edible THC) are constants in
      `packages/compliance/src/constants.ts` with statute
      citations.
- [ ] Beverage limits (≤10 mg/serving, ≤2 servings/container)
      enforced at catalog admission **and** at compliance
      evaluation.
- [ ] Sale-hour rule (8:00 AM – 2:00 AM America/Chicago)
      enforced. DST transitions tested with explicit
      fixtures.
- [ ] Geofence rule (`ST_Contains(delivery_polygon,
address_point)`) enforced. Interstate addresses are
      rejected even if the geofence boundary touches.
- [ ] Age rule (DOB ≥ 21 years before today, server-side)
      enforced.
- [ ] Driver ID-scan rule (no `delivered` state without a
      Veriff session reference) enforced by the order
      state machine.
- [ ] Compliance test suite passes:
      `pnpm --filter @dankdash/compliance test -- --coverage`
      with **100% line coverage**.
- [ ] Compliance check is re-run inside the checkout
      transaction (not just at cart preview).
- [ ] The full `RuleResult` is snapshotted onto
      `orders.compliance_check_payload`.
- [ ] Compliance test failures block deploys via the
      CI pipeline.

### 4.4 Kill switches

The following GrowthBook feature flags must exist as global
kill switches:

- [ ] `payments.accepting_new_charges` — flip to disable
      checkout (Aeropay outage).
- [ ] `metrc.posture` — `NORMAL` | `DRAIN` | `HOLD` |
      `STOP` (Metrc outage).
- [ ] `dispatch.acceptingNewOrders` — global accept new
      offers.
- [ ] `driver.forceUpgradeBelow` — minimum DankDasher
      version.
- [ ] `consumer.forceUpgradeBelow` — minimum DankDash
      consumer version.
- [ ] `geofence.serviceArea` — kill switch by ZIP / city.
- [ ] `flags.killSwitchPanic` — master shutoff for sales.

Each flag has a documented use case in a runbook and a
named owner.

## 5. Identity & payments

**Owner:** Platform.

**Definition of Done:** A real account can be created end
to end, a real $1 order can be placed and delivered, and
the funds settle to the dispensary.

- [ ] Account creation flow:
  - [ ] Phone OTP via Twilio (production).
  - [ ] Age gate (≥ 21).
  - [ ] Veriff ID-scan completed and result stored as
        encrypted reference only.
- [ ] Login flow:
  - [ ] JWT issued, refresh-rotation enforced.
  - [ ] Session revocation works (Settings → Log out of all
        sessions).
- [ ] MFA enabled for staff accounts.
- [ ] $1 end-to-end smoke test, run by Platform lead, on
      production with a Platform-team test customer
      account:
  - [ ] Cart built.
  - [ ] Compliance check passes.
  - [ ] Checkout succeeds.
  - [ ] Aeropay ACH initiated.
  - [ ] Order dispatched.
  - [ ] Driver accepts, picks up, ID-scans, delivers.
  - [ ] Metrc receipt generated and acknowledged.
  - [ ] Settlement appears on next dispensary payout.
  - [ ] All operational logs in Sentry / Grafana clean.

## 6. iOS apps

**Owner:** iOS lead.

**Definition of Done:** Both apps are accepted into the App
Store, install on a real device, and complete the smoke
test in Section 5.

### 6.1 Consumer app (DankDash)

- [ ] App Store Connect record created with Apple-cannabis
      workaround notes.
- [ ] Privacy Label submitted and matches Privacy Policy.
- [ ] In-app legal links work (Terms / Privacy /
      Disclosures).
- [ ] In-app account-deletion path tested end-to-end
      (Section 3 of `account-deletion-request.md`).
- [ ] Push notifications working with production APNs cert.
- [ ] Age-gate disclosure shown on first launch.
- [ ] Federal/state conflict disclosure shown during
      onboarding.
- [ ] TestFlight build approved by App Store Review.
- [ ] Production build submitted with App Review Notes
      including the Apple cannabis workaround context.
- [ ] First production approval received.

### 6.2 Driver app (DankDasher)

- [ ] App Store Connect record created (this app is
      enterprise / TestFlight-distributed unless Apple has
      cleared general availability — confirm posture).
- [ ] Driver onboarding wired to DocuSign signature flow
      `[DEFERRED — see ADR 0009]`.
- [ ] Compliance Handbook in-app and acknowledgement
      tracked.
- [ ] Veriff handoff scan working on production.
- [ ] Offline-tolerant order-state caching tested.
- [ ] TestFlight build distributed to launch drivers.
- [ ] Driver-app crash-rate < 0.1% over 1,000-session
      smoke run.

## 7. Vendor portal & onboarding `[DEFERRED — see ADR 0009]`

**Owner:** Web lead.

**Definition of Done:** Dispensary Partners can self-onboard,
sign the Vendor Agreement via DocuSign, upload their
licenses, and manage their catalog from the portal.

- [ ] Portal scaffolding (auth shell, layout, RBAC) — this
      depends on Phase 13 which has not yet been written.
- [ ] Vendor onboarding wizard (Phase 22.4) — deferred per
      ADR `0009-phase22-prelaunch.md` until portal
      scaffolding lands.
- [ ] Driver onboarding wizard (also Phase 22.4) —
      deferred for the same reason.
- [ ] Admin console (Phase 22.1) — deferred. Manual SQL +
      runbook-driven operations cover the launch window.

`[OPEN ISSUE]` — these items are launch-blocking only if we
intend to onboard partners and drivers via self-service at
launch. The launch-soft posture is **internal manual
onboarding** for the first 3 dispensaries and 15 drivers,
which removes the dependency on the portal. Confirm with
operations before launch.

## 8. Observability & alerting

**Owner:** SRE.

**Definition of Done:** Every critical metric has an
alert; every alert has a named owner and a runbook;
every runbook has been dry-run within the last 30 days.

- [ ] Sentry production project receives errors from API,
      workers, realtime, portal, iOS apps.
- [ ] PII redaction paths verified (pino redact + Sentry
      SDK options).
- [ ] OpenTelemetry traces flowing to the OTLP endpoint;
      spans visible in Grafana Tempo (or equivalent).
- [ ] Metrics dashboards live (see `infra/grafana/`):
  - [ ] API latency p50/p95/p99
  - [ ] DB query p95 + slow-query log
  - [ ] BullMQ queue depth + failure rate
  - [ ] Metrc reporting lag
  - [ ] Aeropay error rate
  - [ ] Driver dispatch latency
  - [ ] Order error rate
  - [ ] Consumer app crash rate
  - [ ] Driver app crash rate
- [ ] Alert rules provisioned and routed to PagerDuty:
  - [ ] `OrderErrorRateBurst` (5% over 10m) — sev-1
  - [ ] `MetrcReportingLagCritical` (>20h) — sev-1
  - [ ] `AeropayErrorBurst` (>5% over 5m) — sev-1
  - [ ] `DBPrimaryDown` (sync replica heartbeat fail) — sev-1
  - [ ] `DriverAppCrashSpike` — sev-2
  - [ ] `ConsumerAppCrashSpike` — sev-2
  - [ ] `JWTKeyExpiringSoon` (30 days) — sev-3
  - [ ] `BackgroundCheckProviderError` — sev-2
  - [ ] `PgBouncerSaturation` (>85%) — sev-2
  - [ ] `OTELCollectorDown` — sev-3
- [ ] Each alert has a runbook in `docs/runbooks/`.
- [ ] Dry-run of each sev-1 runbook completed in the last
      30 days. Results logged in
      `docs/compliance/drills/<runbook>-YYYY-MM-DD.md`.

## 9. On-call & support

**Owner:** Operations.

**Definition of Done:** Someone is responsible at all hours
during sale hours and for 2 hours after, and a customer or
driver in distress can reach a human.

- [ ] On-call rotation populated for 4 weeks ahead in
      PagerDuty.
- [ ] Primary + secondary on-call for each shift.
- [ ] Escalation policy: primary (5m) → secondary (15m) →
      engineering manager (30m) → CEO (60m).
- [ ] CS team trained on:
  - [ ] `customer-complaint-escalation.md`
  - [ ] `data-export-request.md`
  - [ ] `account-deletion-request.md`
  - [ ] Refund authority matrix.
- [ ] CS hours and channels documented at
      `dankdash.com/help`:
  - [ ] In-app Help → Chat (during sale hours + 2h)
  - [ ] support@dankdash.com (24/7, 4-hour first response
        SLA during sale hours)
  - [ ] safety@dankdash.com (24/7, 1-hour first response
        SLA — incident reports)
  - [ ] (911 explicitly for emergencies — not us)
- [ ] Status page at `status.dankdash.com` configured.
- [ ] Communications templates ready:
  - [ ] Outage email (Aeropay, Metrc, app down).
  - [ ] Breach notification email (Minn. Stat. § 325E.61).
  - [ ] Account-deletion confirmation.
  - [ ] Data-export delivery.
  - [ ] Refusal letters (data-export refusal,
        account-deletion refusal).

## 10. Marketing site & legal hosting

**Owner:** Web lead.

**Definition of Done:** The marketing site is live at
`dankdash.com`, links to the App Store correctly, and
hosts the legal documents at the expected URLs.

- [ ] `dankdash.com` resolves and renders the home page.
- [ ] `dankdash.com/legal/terms` resolves and renders the
      cleared Terms of Service.
- [ ] `dankdash.com/legal/privacy` resolves and renders the
      cleared Privacy Policy.
- [ ] `dankdash.com/legal/disclosures` resolves and renders
      the cleared Cannabis Compliance Disclosures.
- [ ] App Store link works on iOS and degrades gracefully
      on other platforms.
- [ ] Site is not indexed by search engines for
      cannabis-purchasing keywords prior to launch
      (`robots.txt` and meta-noindex on order pages).
- [ ] CCPA / GDPR cookie banner is configured (currently
      not surfaced because all cookies are essential —
      see Privacy Policy Section 4; confirm with counsel).

## 11. Final go / no-go meeting

**Owner:** CEO.

**Definition of Done:** Every section above is signed off,
the CEO has called Go, and the launch is scheduled.

- [ ] T-7 days: dry-run rehearsal with all on-call.
- [ ] T-3 days: final compliance review with outside
      counsel.
- [ ] T-1 day: smoke test in production at the actual
      production sale hour.
- [ ] T-0: First real consumer order accepted. Marketing
      announcement scheduled.
- [ ] T+24 hours: Post-launch review meeting — what
      surprised us, what to fix, what to add to this
      checklist for the next launch.

---

## Appendix A — Items deferred to post-launch

These items have been intentionally deferred to post-launch
work; their absence does not block launch:

- Admin console (Phase 22.1) — operate via manual SQL +
  runbooks until portal scaffold lands (ADR
  `0009-phase22-prelaunch.md`).
- Self-onboarding wizards (Phase 22.4) — internal manual
  onboarding for launch.
- Vendor portal scaffolding (Phase 13) — entirely deferred.
- Tablet apps for dispensary fulfillment — vendor-portal
  web only at launch.
- Loyalty / referral program — out of MVP scope.
- iPad-optimized layouts for any of the iOS apps.

## Appendix B — Risk-acknowledgement signatures

The CEO, CTO, Head of Compliance, and outside counsel each
acknowledge having read this checklist and the underlying
risks. Their signatures are recorded below at launch time.

| Role               | Name          | Date         | Signature |
| ------------------ | ------------- | ------------ | --------- |
| CEO                | [NAME]        | [YYYY-MM-DD] | [SIGNED]  |
| CTO                | [NAME]        | [YYYY-MM-DD] | [SIGNED]  |
| Head of Compliance | [NAME]        | [YYYY-MM-DD] | [SIGNED]  |
| Outside counsel    | [FIRM / NAME] | [YYYY-MM-DD] | [SIGNED]  |
