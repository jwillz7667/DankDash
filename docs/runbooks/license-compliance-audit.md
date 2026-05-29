# OCM license compliance audit response

## Purpose

The Minnesota Office of Cannabis Management (OCM) may at any
time exercise its statutory authority under Minn. Stat. § 342.30
to audit a licensed cannabis operator's records. DankDash holds a
**cannabis delivery service license** and additionally relies on
the dispensary-side **cannabis retailer licenses** of every
partner dispensary. An OCM audit may be:

- **Scheduled** — a routine periodic review with 7–14 days notice.
- **For-cause** — a complaint, incident, or self-report
  triggered audit, typically with 48–72 hours notice.
- **No-notice on-site** — OCM's statutory authority to enter a
  licensed premises during business hours without notice. For a
  delivery service, "premises" means the registered office; the
  on-call manager admits them.

This runbook is the operator playbook for assembling and
delivering the records OCM requests, with the priorities that
matter for protecting the license.

## Authority and scope

Per § 342.30, OCM may request:

- Sale records (every delivered order with line items, dollar
  values, customer-age verification, dispensary source).
- Metrc reconciliation records (our `metrc_receipts` ←→ Metrc
  delivered ledger).
- Driver records (background-check status, vehicle records,
  delivery-day shift logs).
- Compliance evaluation logs (our `compliance_check_log`
  table — every evaluation result for the audited window).
- Incident logs (every order touching ID-scan-failed,
  returned-to-store, tampering complaint, etc.).
- KYC records (customer DOB verification, ID scan results, IDs
  on file).
- Training records (driver onboarding training completions).
- Geofence boundary records (every delivery's destination
  coordinate vs. dispensary's `delivery_polygon`).

OCM is **entitled to all of the above** within the scope of the
audit window. Refusing to produce records is a license-risk
event. The right posture is full transparency, organized
delivery, and a calm timeline.

OCM is **not entitled to**:

- Records outside the audit window (defend the window scope).
- Records that identify customers by name when the audit purpose
  does not require it (offer customer-ID UUIDs first; full
  identifiers only on specific request and only for in-scope
  customers).
- Records on dispensaries that are not part of the audit (each
  dispensary holds its own license; their audit is theirs to
  manage).

## When to fire

The CS supervisor, legal counsel, or compliance officer notifies
`#incidents` and `@cto` when:

- An OCM letter arrives (paper, email to `compliance@dankdash.com`,
  or hand-delivered).
- A field inspector requests records on-site.
- A self-report we filed triggers a follow-up.

PagerDuty is **not** used for OCM audits — the matter is
sensitive and on-record, so paging the engineering rotation
through PagerDuty would create a transcript we don't want.
Internal Slack + Linear is the right channel.

## Procedure

### Step 0 — Acknowledge to OCM

Within the timeframe OCM gives (typically 5 business days for
scheduled, 48 hours for for-cause):

1. The compliance officer responds to OCM in writing acknowledging
   the request, naming the assigned point-of-contact (compliance
   officer or legal counsel), and stating the date by which
   records will be delivered.
2. The response goes through legal counsel before sending.
3. The acknowledgement letter goes into Linear ticket `OCM-<n>`
   and a copy goes to `docs/compliance/audits/YYYY-<n>/`.

Do not send substantive answers in the acknowledgement.
"We are gathering the requested records" is the right posture.

### Step 1 — Confirm scope and window

Read the OCM request carefully. The compliance officer writes a
scope memo for the engineering team listing exactly:

- The date window of records requested (start + end, in
  America/Chicago, expressed as both local time and UTC).
- The license number(s) the audit covers (DankDash and which
  dispensary partners, if any).
- The record categories requested (line by line from the OCM
  letter).
- Any specific orders / drivers / customers OCM has named.

Anything outside this scope is **out-of-scope and not produced
unless OCM expands the request**. The engineering team produces
only what the scope memo names.

### Step 2 — Engineering assembles the records

Run the audit-assembly script:

```sh
pnpm --filter @dankdash/api exec -- \
  audit-assemble \
    --window-start '<iso>' \
    --window-end '<iso>' \
    --licenses '<csv-of-licenses>' \
    --reason 'OCM-<n>' \
    --output 's3://dankdash-audit/OCM-<n>/'
```

The script produces, into the named S3 prefix:

- `orders.csv` — every order in the window matching the
  licenses, with: id, dispensary_license, customer_id (UUID
  only), placed_at, delivered_at, status, subtotal_cents,
  tax_cents, delivery_fee_cents, total_cents, driver_id (UUID).
- `order_items.csv` — line items for the orders above, with
  product names, quantities, prices, and the package_tag from
  Metrc.
- `compliance_evaluations.csv` — every `compliance_check_log`
  row in the window, with the full RuleResult JSON.
- `id_scans.csv` — every ID-scan event (success/fail, Veriff
  session ID, NOT the scan image), keyed to order ID.
- `metrc_receipts.csv` — Metrc submission record per order.
- `drivers.csv` — drivers active in the window, with
  background-check status (status only, not the underlying
  report), onboarding-training completion dates.
- `incidents.csv` — any `cs-esc-*` linear tickets in the window
  scoped to the requested licenses.
- `geofence_compliance.csv` — every delivery's destination
  coordinate, the dispensary's polygon, and the `ST_Contains`
  result.
- `MANIFEST.txt` — checksum + row-count per file, the scope
  memo from Step 1, the assembly script version + commit SHA.

Customer PII is included only at the UUID level. If OCM
specifically requests customer identifiers, the compliance
officer requests written confirmation of the scope before adding
a `customers.csv` (DOB, name, address) to the package.

### Step 3 — Legal review

Before the package leaves DankDash, legal counsel reviews:

- That the package matches the scope memo (no over-disclosure,
  no under-disclosure).
- That every file's content matches OCM's expected schema (OCM
  publishes a record-format guide; verify columns and dates
  conform).
- That the manifest's row counts pass the spot-check (e.g., the
  `orders.csv` count matches `count(*) from orders where ...`).

The compliance officer signs the manifest. Counsel signs the
cover letter.

### Step 4 — Deliver

Per OCM's stated preference (the letter usually specifies):

- **Secure file transfer.** OCM publishes a portal; upload the
  package there with the audit reference number.
- **Physical media.** If OCM requests a USB drive (uncommon but
  permitted), encrypt with `gpg --symmetric` using a passphrase
  delivered to OCM through a separate channel (call the audit
  point of contact, recite the passphrase).
- **In-person handoff.** The compliance officer attends the OCM
  office with the package on encrypted media.

Record the delivery confirmation. File it under
`docs/compliance/audits/YYYY-<n>/delivery-confirmation.pdf`.

### Step 5 — Standing questions and follow-up

OCM usually has follow-up questions. Each is a Linear sub-ticket
under `OCM-<n>`. The compliance officer is the single point of
contact; engineering answers through them, never directly to
OCM. This keeps the record consistent and the privilege intact.

If OCM expands the scope mid-audit, **the scope memo is
re-issued** (Step 1) and engineering produces an addendum
package. Do not re-use the original assembly to cover the
expanded window — re-assemble from scratch so the manifest
matches the new scope.

### Step 6 — Closure

Audits close with one of:

- **No findings.** OCM issues a closure letter. File it under
  the audit directory. Update the compliance dashboard with the
  result.
- **Findings — corrective action required.** OCM names specific
  items to remediate, with deadlines. Each becomes a Linear
  ticket (`OCM-<n>-CA-<i>`). The compliance officer tracks
  closure of each.
- **Findings — enforcement action.** Fines, license suspension,
  or revocation. Legal counsel takes lead. This is no longer an
  audit-response runbook scenario; it is litigation.

## Retention

Every audit package, every cover letter, every OCM reply, every
follow-up exchange is retained for **7 years** under
`docs/compliance/audits/YYYY-<n>/`. The retention is enforced by
the S3 bucket lifecycle policy + a Linear-side process audit.
Do not delete audit artifacts even after the audit closes; OCM
may re-open or cross-reference in a subsequent audit.

## Pre-audit hygiene (continuous)

These are the things the compliance officer keeps in shape so
that an audit assembly is hours, not weeks:

- `compliance_check_log` is **append-only** and partitioned by
  month. The audit assembly script reads partitions directly;
  performance scales to 100M+ rows.
- `order_events` is **append-only** with DB-level write-only
  permissions on the app role.
- Driver background-check status is stored in
  `driver_background_checks.status` (enum) — the underlying
  Checkr/Onfido report is referenced by `report_id` but the
  payload is held by the vendor, not by us. OCM gets the
  status; the vendor handles the underlying record on its own
  retention schedule.
- Metrc receipts and Metrc reconciliation logs are retained
  alongside the audit package; the `metrc_reconcile.cron.ts`
  output is itself an evidentiary artifact.
- The data-classification map in `docs/spec/DankDash-Technical-Spec.md`
  §8.1 names every column's classification; the audit-assembly
  script reads this map to know what to include and what to
  redact.

## Postmortem template

After every audit closes, the compliance officer writes a
**process review** (not a postmortem — there was no incident)
under `docs/compliance/audits/YYYY-<n>/process-review.md`:

- Audit type (scheduled / for-cause / no-notice).
- Date range from OCM letter to closure.
- Engineering effort hours.
- Any record category that was slow to assemble.
- Any record OCM asked for that we did not have or could not
  produce in the requested form.
- Followups for next audit (record-quality, tooling, process).

The review is a forward-looking document; it does not assign
blame for any audit findings (those are handled through the
corrective-action tickets).
