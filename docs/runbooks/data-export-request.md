# Data subject access (export) request

## Purpose

A user — customer, driver, or dispensary user — has the right
to request a copy of the personal data DankDash holds about them.
Minnesota law (Minn. Stat. § 325O, the consumer data privacy
act effective 2025) gives every Minnesota resident a portability
right; Apple App Store policy 5.1.1(iv) requires we honor the
request regardless of jurisdiction. This runbook is the operator
playbook for assembling and delivering a data-export package
that satisfies both requirements and does so within 30 days of
the verified request.

This runbook is **distinct from account deletion** — exports
return data to the user; deletion erases it. A user may request
both (export first, then delete) and the two requests are
processed separately.

The companion code:

- `apps/api/src/features/privacy/data-export.controller.ts` —
  exposes `POST /v1/privacy/export-request` for the in-app form.
- `apps/workers/src/jobs/data-export-builder.ts` — the worker
  that runs the assembly off the request queue.
- `packages/privacy/` — the shared "what fields belong to which
  subject" map.

## When to fire

The trigger is **any of**:

- An in-app data-export form submission lands on the
  `data-export-request` queue.
- An email to `privacy@dankdash.com` from a verified account
  email (auto-routed by the support tool with the
  `data-export` label).
- A signed letter to the registered office requesting a copy of
  personal data.

Each path lands here at Step 0. The clock for the 30-day SLA
starts from **request verification** (Step 1), not from the
raw inbound — but it is the operator's job to verify quickly,
not stall by sitting on the inbound.

## Procedure

### Step 0 — Triage

Within 1 business day of inbound:

1. The privacy on-call (rotates weekly among the compliance
   team) opens a Linear ticket in the `PRIVACY-EXP` project.
2. Tag with subject type (`customer` | `driver` | `vendor-user`).
3. Capture the inbound channel and the raw verification
   evidence (email headers, in-app event ID, letter PDF).

### Step 1 — Verify the requester

A data export is a high-value target for impersonation —
returning the data to the wrong person is itself a privacy
breach. Verification requires:

- **For customers:** the request must come from an authenticated
  in-app session (the form is gated by current login), OR a
  reply-to-confirm email sent to the account-of-record email.
  An unauthenticated email asking for data is **never honored
  without a follow-up authentication challenge**.
- **For drivers:** the request must come from an authenticated
  in-app session OR a reply-to-confirm sent to the
  account-of-record email AND a phone-callback to the driver's
  registered number to confirm out-of-band.
- **For vendor users:** the request must come from an
  authenticated portal session OR a reply-to-confirm sent to
  the account-of-record email AND a separate confirmation from
  another authorized user on that vendor account (privacy
  rights belong to the natural person; the vendor's other
  users do not own this person's data, but their confirmation
  helps verify identity).

If the requester is asking on behalf of a third party
(e.g., parent of a minor — DankDash does not serve minors, so
this should not happen, but a deceased subject's executor may),
escalate to legal counsel before proceeding.

Verification result lands on the Linear ticket. The 30-day SLA
clock starts now.

### Step 2 — Run the assembly

```sh
pnpm --filter @dankdash/api exec -- \
  data-export build \
    --subject-id <uuid> \
    --subject-type <customer|driver|vendor-user> \
    --reason "PRIVACY-EXP-<linear-id>" \
    --output "s3://dankdash-privacy/exports/PRIVACY-EXP-<linear-id>/"
```

The script produces:

#### Customer subject

- `profile.json` — name, email, phone (masked in app, full in
  export), DOB, addresses (current + historical), preferences.
- `orders.json` — every order placed by this customer with line
  items, delivery address (snapshotted at order time), driver
  display name (UUID only — the driver's name is not the
  customer's data), dispensary display name.
- `compliance_evaluations.json` — every compliance check this
  customer's carts triggered, with the result. (Necessary for
  the customer to understand why a cart was blocked, if any.)
- `id_scan_history.json` — every Veriff session opened (session
  ID, outcome, timestamp) — the scan image itself is held by
  Veriff under their retention policy; we provide the Veriff
  reference and a pointer to Veriff's separate data-subject
  process for the underlying image.
- `payment_history.json` — every payment transaction (provider
  ref masked, amount, status). The account-and-routing number
  associated with the Aeropay link is **not** included; it is
  held by Aeropay, not by us.
- `messaging.json` — in-app messages with drivers (read-only;
  the driver's PII redacted to display name).
- `audit_log.json` — every login, every account-setting change
  with timestamps.

#### Driver subject

- `profile.json` — name, email, phone, address, license number
  (masked), vehicle info.
- `background_check_status.json` — status only; the report
  itself is held by Checkr / Onfido under their retention. We
  provide a pointer to their separate data-subject process.
- `shifts.json` — every shift with start/end timestamps,
  delivery count, earnings.
- `deliveries.json` — every order the driver delivered (UUID-
  only customer reference; the customer's name and address are
  not the driver's data; aggregated stats only).
- `payouts.json` — every payout.
- `incident_log.json` — any CS-escalation tickets that named
  this driver as the subject.

#### Vendor-user subject

- `profile.json` — name, email, phone, role at the vendor.
- `actions.json` — every back-office action this user performed
  (catalog edits, order interventions, refunds approved). The
  customer-side data those actions touched is not included; it
  is not the vendor user's data.
- `audit_log.json` — login and setting-change events.

#### Common

- `MANIFEST.txt` — record counts per file, the assembly script
  version + commit SHA, the verification record from Step 1,
  the subject's UUID.

The script writes the package to S3 with a 30-day lifecycle —
once delivered to the requester it expires automatically.

### Step 3 — Redact other people's PII

The assembly script is conservative by default — it tags
fields as "subject's own" or "third party" and produces a
report listing every field tagged "third party". Examples:

- A customer's `orders.json` references a driver's display
  name. That name is the _driver's_ PII, not the customer's.
  The script outputs the driver's UUID and a `driver_first_name`
  initial only.
- A driver's `deliveries.json` references customer addresses.
  Those addresses are the _customer's_ PII, not the driver's.
  The script outputs the geocoded coordinate (which the driver
  saw at the time of delivery) but redacts the street address.

The privacy on-call reviews the third-party-fields report
before delivery. Anything that should not have been included
is removed by hand. Anything missing is added back if it is
unambiguously the subject's own data.

### Step 4 — Legal review

For first-of-kind requests in a category (the first export of a
deceased-customer record, the first export naming a third party
in a contested context, the first export under a non-Minnesota
jurisdiction's rules), legal counsel reviews the package before
delivery.

Routine exports do not require legal review; the privacy
on-call has standing authority to deliver.

### Step 5 — Deliver

Generate a one-time-use signed URL valid for **7 days**:

```sh
pnpm --filter @dankdash/api exec -- \
  data-export deliver \
    --linear-id PRIVACY-EXP-<id> \
    --expires-in 7d
```

Email the URL to the verified account-of-record email along
with the `data-export-delivery.md` template, which explains:

- The package format (JSON files in a tar.gz).
- The link's 7-day expiry.
- What is included and what is held by upstream partners
  (Veriff, Checkr / Onfido, Aeropay).
- How to request deletion if they choose.

After the link expires, the S3 lifecycle removes the package
30 days after creation regardless of whether it was downloaded.

### Step 6 — Confirm delivery, close the ticket

The Linear ticket holds:

- Delivery confirmation (download event, if available; otherwise
  the timestamp of the email send + the expiry of the link).
- The 7-day inbound from the requester for any follow-up
  questions.

If no follow-up arrives in 7 days, the ticket closes. The
inbound channel-of-record (in-app form submission, the
`privacy@` thread) is preserved for 7 years per the privacy-act
record-keeping requirement.

## When we can refuse or restrict

Under § 325O.05(c), a controller may refuse a request if it is:

- **Manifestly unfounded or excessive.** A second export
  request from the same subject within 6 months may be charged
  for or refused. Coordinate with legal.
- **Impossible.** A subject who deleted their account 14 months
  ago has no data to export beyond the regulatory-retention
  minimum; the response is the retained subset.
- **Adverse to another person's rights.** Specific cases:
  pending civil litigation between the subject and another
  party where disclosure would compromise the other party's
  position; ongoing internal investigation where disclosure
  would compromise the investigation. Legal counsel decides.

A refusal goes out as a formal letter (template
`data-export-refusal.md`) explaining the basis and the
subject's right to appeal (to the MN Attorney General).

## Retention exceptions

Some data **cannot** be deleted on request; those subsets are
included in the export but called out in the package:

- **Cannabis sale records.** Minn. Rule 21-23 requires retention
  for 7 years for OCM audit purposes. We retain the order,
  line items, and compliance check records for 7 years even
  after a deletion request.
- **Tax records.** IRS retention rules require 7 years.
- **Anti-fraud records.** Records of confirmed fraud, with
  legal counsel sign-off, may be retained indefinitely.

The export delivers all retained data; the deletion runbook
explains what cannot be deleted.

## Postmortem template

Not normally applicable — this is routine compliance work, not
incident response. For exceptional requests (deceased subject,
disputed third-party PII, refused request escalating to
litigation), file a process note under
`docs/compliance/privacy/exceptional-exports/YYYY-MM-<linear-id>.md`
for legal counsel review.
