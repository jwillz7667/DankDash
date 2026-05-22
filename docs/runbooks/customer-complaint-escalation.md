# Customer complaint escalation

## Purpose

Most customer complaints are routine: late delivery, wrong item,
billing dispute. The customer support (CS) team owns them and
resolves them at Tier 1 without engineering involvement. A
handful of complaint categories, though, are **regulator-touching
or safety-touching** and route through this runbook because
mishandling them creates legal exposure for the business and
its dispensary partners. This document is the explicit triage
ladder.

The companion artifacts:

- `apps/portal/src/app/admin/complaints/` (when built — see ADR
  `0009-phase22-prelaunch.md`) — the back-office tool.
- `docs/legal/templates/` — the customer-facing letter templates
  for each category.
- Linear project `CS-ESC` — the escalation queue.

## Categories that escalate

| #   | Category                                 | Owner            | Notify within |
| --- | ---------------------------------------- | ---------------- | ------------- |
| 1   | Underage delivery (anyone in the home)   | Legal + CEO      | Immediate     |
| 2   | Allegation of impaired driver            | Legal + Dispatch | Immediate     |
| 3   | Tampered package on arrival              | Compliance       | 1 hour        |
| 4   | Adverse health reaction (allergic, etc)  | Compliance + CEO | 1 hour        |
| 5   | Wrong product (THC content mismatch)     | Compliance       | 4 hours       |
| 6   | Suspected counterfeit packaging          | Compliance + OCM | 4 hours       |
| 7   | Driver misconduct (non-impaired)         | HR + Dispatch    | 24 hours      |
| 8   | Privacy concern / data leak              | Legal + Security | Immediate     |
| 9   | Threats / harassment between user/driver | HR + Security    | 1 hour        |

Anything not in this list stays at Tier 1 CS. The Tier 1 playbook
lives in the CS knowledge base, not in this repo.

## When to fire

The trigger is **any of**:

- A CS agent flags the ticket with `escalate-to-engineering` or
  `escalate-to-compliance` in the support tool.
- A customer email comes in to `legal@dankdash.com` or `compliance@dankdash.com`
  (both are monitored shared inboxes; auto-forwarded to PagerDuty
  for the two "Immediate" categories above).
- A regulator (OCM, Department of Public Safety) contacts us
  directly about a customer matter.

Each path lands in this runbook at Step 0.

## Procedure

### Step 0 — Acknowledge and categorize

Within 15 minutes of escalation, the on-call CS supervisor
opens the ticket in Linear (`CS-ESC` project), tags the category
from the table above, and posts in `#cs-escalations` Slack with:

- Ticket ID
- Customer ID (UUID — never name, never email)
- Category
- Time received
- Brief one-line summary

Do not include PII in the Slack post. The Linear ticket is the
PII-bearing artifact; Slack is the routing signal.

### Step 1 — Preserve evidence (do this before anything else)

Before any reply is sent to the customer, preserve the supporting
evidence so a future investigation has the record:

```sh
pnpm --filter @dankdash/api exec -- \
  evidence-snapshot --order-id <uuid> --reason cs-esc-<linear-id>
```

This script:

- Snapshots the order row + all `order_events` + all
  `order_status_history` rows.
- Snapshots the driver-location track for the delivery window.
- Snapshots the ID-scan result (success/failure + Veriff
  session ID; never the scan image).
- Snapshots the compliance evaluation that was stored on
  `orders.compliance_check_payload`.
- Writes the snapshot to `s3://dankdash-evidence/<ticket-id>/`
  with a 7-year retention lock.

The snapshot does not include the customer's chat history with
CS; that lives in the support tool and is preserved by its own
retention policy.

If the complaint is **driver misconduct** (categories 1, 2, 7,
9), additionally pull the driver's shift log + the relevant
order assignment chain so the HR side has the full picture:

```sh
pnpm --filter @dankdash/api exec -- \
  driver-shift-snapshot --driver-id <uuid> --window 24h \
  --reason cs-esc-<linear-id>
```

### Step 2 — Notify the owner

Use the table at the top of this runbook. The "Immediate"
categories have PagerDuty rotations; the CS supervisor pages
them directly.

For the others, the CS supervisor messages the named owner in
their team Slack channel with the Linear ticket ID and a one-line
summary, then waits for acknowledgement. The Linear ticket is
moved into the owner's queue.

### Step 3 — Customer communication

**Do not send a holding reply that admits liability or describes
the incident in detail.** Use the templates in
`docs/legal/templates/`:

- `cs-esc-acknowledgement.md` — "We received your message and
  are looking into it." Sent within 1 hour for "Immediate"
  categories, within 4 hours for others.
- `cs-esc-investigation-update.md` — sent at 24, 48, 72 hours
  if the matter is still open.
- `cs-esc-resolution.md` — final reply once the matter is
  closed. Tone is empathetic, factual, and aligned with what
  the legal/compliance owner has signed off on.

If the customer is asking for a refund, the **Refund authority
matrix** decides who can grant it:

| Order value (cents) | Tier 1 CS | Tier 2 supervisor | Compliance | CEO |
| ------------------- | --------- | ----------------- | ---------- | --- |
| ≤ $50               | ✓         | ✓                 | ✓          | ✓   |
| $51 – $250          |           | ✓                 | ✓          | ✓   |
| $251 – $1000        |           |                   | ✓          | ✓   |
| > $1000             |           |                   |            | ✓   |

Refunds for category-1/2 (underage / impaired) complaints
**always go through Legal first** regardless of dollar value —
the refund language carries liability implications and Legal
shapes the letter.

### Step 4 — Per-category investigation

#### Category 1: Underage delivery

The id-scan-at-handoff step (`idScanPending → idScanPassed`)
should make this impossible. If a complaint of underage
delivery comes in, the most likely scenarios are:

- Adult of legal age accepted the delivery for someone underage
  who later consumed (not our liability under MN rules but is
  ours under the brand-trust posture).
- ID scan was a false-positive — Veriff confirmed someone who
  is in fact underage. Pull the Veriff session for review.
- Manual override happened (`idScanFailed` then admin override
  to `delivered`). **This is the bad path.** Pull the admin
  override audit log.

Legal counsel decides on (a) regulator notification (OCM has
posted guidance that they expect notification within 24h for
confirmed underage deliveries), (b) customer remediation, and
(c) driver disciplinary action.

#### Category 2: Impaired driver allegation

`@dispatch-on-call` pulls the driver offline immediately:

```sh
pnpm --filter @dankdash/api exec -- \
  driver-tool force-offline <driver-id> --reason 'cs-esc-impairment-allegation'
```

The driver-side iOS app shows "you've been temporarily set
offline pending review" and refuses to accept new offers. The
driver's manager calls them. HR opens a fitness-for-duty review.

The customer-side response is the
`cs-esc-acknowledgement.md` template. We do not confirm or
deny impairment to the customer pending the HR review.

#### Category 3: Tampered package

Pull the delivery photo (if any) and the chain-of-custody log.
The dispensary partner is notified — most often tampering is
upstream of us (POS-side packaging issue) rather than a driver
issue. Compliance team coordinates with the dispensary and
OCM if the tampering implicates seal-integrity rules.

#### Category 4: Adverse health reaction

Triage to a clinical-safety mode: gather product, batch number
(from the COA record on `orders.compliance_check_payload`),
symptoms, time-since-consumption. The Compliance officer
contacts the dispensary's regulatory affairs team and may
recommend a batch recall. The customer is asked (not required)
to seek medical attention and to share the medical record if
they choose; we never push for medical info.

OCM notification is required for any reaction involving
emergency-room visit or worse. Legal counsel handles the
filing.

#### Category 5: Wrong product (THC content mismatch)

Compare the COA on `orders.compliance_check_payload` against
what the customer reports. If the COA shows the correct
content but the customer's experience disagrees, the most
likely cause is product variability within the legal labeling
band — explain the labeling tolerance in the response.

If the COA was wrong (lab error upstream), this is a
batch-recall scenario; same path as Category 4 minus the
clinical-safety urgency.

#### Category 6: Counterfeit packaging

Pull the product images from the menu listing. Compare with
the manufacturer's authentic-product photo (maintained in the
compliance team's reference library). Suspected counterfeit
flows to OCM under the diversion-tracking obligation.

#### Category 7: Driver misconduct (non-impaired)

HR opens a personnel review. The customer is offered a
follow-up call. The driver is not paused unless the misconduct
is egregious (theft, sustained verbal abuse, refusal to
deliver to a complete address); minor complaints feed into the
driver performance review and may result in coaching, not
discipline.

#### Category 8: Privacy / data leak

Security team takes lead. Apply the data-leak playbook in
`docs/runbooks/data-leak-response.md` (separate runbook,
covers the technical investigation path). Legal handles the
customer-facing response and any breach-notification
obligations under MN data-breach law.

#### Category 9: Threats / harassment

If the threat is between user and driver and is ongoing,
escalate to local law enforcement at the affected party's
request. Pause whichever account is the source pending HR/CS
review. Pull the chat history (in-app messaging is logged on
`messaging_threads`) as evidence.

### Step 5 — Resolution and ticket close

For all categories:

1. The owner posts a resolution summary on the Linear ticket.
2. The customer is sent the `cs-esc-resolution.md` template,
   adapted to the category.
3. The ticket is moved to `closed`. Linear retains it
   indefinitely; the evidence snapshot in S3 has its own
   7-year retention.
4. Per-category followup actions (driver discipline, dispensary
   contact, OCM filing, product recall) live in their own
   sub-tickets and are tracked separately.

## Reporting

The Compliance officer compiles a monthly report under
`docs/compliance/cs-escalation-report-YYYY-MM.md` with:

- Count of escalations by category.
- Median time-to-acknowledge per category.
- OCM notifications filed.
- Open category-by-category items.

The report goes to the CEO and is the artifact OCM may ask
for in a routine compliance audit. Keep it factual and
auditable.

## Postmortem template

For any category-1, category-2, category-4, or category-8
escalation, write an incident-style postmortem under
`docs/incidents/cs-escalation/YYYY-MM-DD-<ticket>.md`:

- Category and trigger
- Customer & driver IDs (no names in the file)
- Timeline (escalation in, owner ack, customer comms, OCM
  comms if any, resolution)
- Root cause (process, technology, human)
- Followups (process changes, lint rules, training)
