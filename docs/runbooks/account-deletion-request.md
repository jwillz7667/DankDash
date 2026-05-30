# Account deletion request

## Purpose

A user — customer, driver, or dispensary user — has the right
to delete their account and have DankDash erase the personal
data we hold about them. The legal sources of this right:

- **Minn. Stat. § 325O.04** — the right to deletion under
  Minnesota's consumer data privacy act (2025).
- **Apple App Store policy 5.1.1(v)** — apps that allow account
  creation must allow in-app account deletion.
- **EU GDPR Art. 17** — the right to erasure for any EU
  resident who has interacted with us.

This runbook is the operator playbook for honoring those
requests with the right balance of (a) full erasure where the
law requires it, and (b) lawful retention of records the law
also requires us to keep (cannabis sale audit records, tax
records, anti-fraud records).

It is **distinct from data export** — export returns data to
the user; deletion removes it. A user may request both; the
export must be delivered before the deletion runs.

The companion code:

- `apps/api/src/features/privacy/account-deletion.controller.ts` —
  `POST /v1/privacy/delete-account` for the in-app form.
- `apps/workers/src/jobs/account-deletion-executor.ts` — the
  worker that runs the deletion off the request queue. **Runs
  asynchronously after a 14-day cooling-off period** during
  which the user can cancel.
- `packages/privacy/` — the shared "what fields delete vs.
  retain" map.

## When to fire

- An in-app deletion-form submission lands on the
  `account-deletion-request` queue. (Apple's policy requires
  the in-app path; this is the canonical path.)
- An email to `privacy@dankdash.com` from a verified account
  email tagged `account-deletion`.
- A signed letter to the registered office.

## The 14-day cooling-off period

Deletion is **not immediate**. From request to execution:

```
Day 0   — request lands, verified
Day 0   — account suspended (login blocked, app shows the
          "your account is scheduled for deletion" screen)
Day 0   — confirmation email sent with the cancel link
Day 1–13 — user may cancel via the link or in-app
Day 14  — executor worker runs, deletion is final
```

Reasons for the cooling-off period:

- Anti-impulse — many deletion requests are made in frustration
  and revoked within a few days. The cooling-off lets the user
  change their mind without operator intervention.
- Anti-account-takeover — a hijacked account can request
  deletion to wipe the legitimate user's history; the
  legitimate user notices on the next login attempt within 14
  days and can cancel.
- Pending-order safety — a deletion mid-delivery would orphan
  the order. The cooling-off lets in-flight orders complete.

## Procedure

### Step 0 — Triage

Within 1 business day of inbound:

1. Open a Linear ticket in `PRIVACY-DEL`.
2. Tag with subject type (customer | driver | vendor-user).
3. Capture inbound channel + verification evidence.

### Step 1 — Verify the requester

Same verification posture as `data-export-request.md`:

- Authenticated in-app session is the strong path.
- Reply-to-confirm email to the account-of-record email is the
  fallback.
- Driver and vendor-user deletions additionally require
  out-of-band phone confirmation.
- Anonymous emails are not honored.

For a customer with a pending or in-flight order, the deletion
request is **not refused** but the cooling-off period covers
the order; if the order is still in flight at Day 14, the
executor either delays itself until the order reaches a
terminal state or aborts and re-queues with a fresh 14-day
window if the user explicitly chose to abandon the order.

### Step 2 — Suspend immediately

```sh
pnpm --filter @dankdash/api exec -- \
  account-deletion schedule \
    --subject-id <uuid> \
    --subject-type <customer|driver|vendor-user> \
    --reason "PRIVACY-DEL-<linear-id>" \
    --cool-off-days 14
```

The script:

1. Sets the account's `status='deletion_scheduled'` and
   `deletion_scheduled_at = now()`.
2. Revokes all active sessions on the account
   (`auth_sessions.revoked_at = now()`, reason `deletion_scheduled`).
3. Enqueues the executor job with a 14-day delay.
4. Sends the confirmation email with the cancel link.

The user's next login attempt during the 14-day window shows
the "deletion-scheduled" screen with a single button:
**Cancel deletion**. Clicking it cancels the executor job and
clears the suspend flag.

### Step 3 — User cancellation (any time during Day 1–13)

If the user clicks **Cancel deletion**:

```sh
pnpm --filter @dankdash/api exec -- \
  account-deletion cancel \
    --subject-id <uuid> \
    --reason "user-cancelled"
```

The cancel script:

1. Cancels the BullMQ delayed job.
2. Clears `status='deletion_scheduled'`, restoring the prior
   status.
3. Sends the user a "your account is restored" email.
4. Updates the Linear ticket and closes it as cancelled.

### Step 4 — Executor runs (Day 14)

The executor worker picks up the delayed job. It runs **within
a single Postgres transaction per table category** so partial
failure does not leave a half-deleted account.

#### What gets deleted

**Customer subject:**

- `users` row → soft-deleted via `deleted_at = now()`, `email`
  replaced with `deleted-<uuid>@deleted.dankdash.invalid`,
  `phone` nulled, name replaced with `Deleted Customer`.
- `customer_profiles` → hard-deleted (no retention requirement).
- `addresses` → hard-deleted.
- `cart_items` → hard-deleted (cart was never an audit record).
- `auth_sessions` → hard-deleted.
- `messaging_threads` (the customer's side) → messages preserved
  but `sender_user_id` replaced with the deleted-marker user;
  thread visible to the other party (the driver) with the
  customer reference anonymized.
- `id_scan_history` (DankDash side) → hard-deleted. Veriff
  retains the underlying scan image under their separate
  retention; the user must request deletion from Veriff
  directly. We provide the Veriff session reference in the
  deletion confirmation email.
- `payment_methods.aeropay_link_id` → hard-deleted; the link
  to Aeropay is revoked via Aeropay API. The bank account
  detail itself is held by Aeropay and is their data-deletion
  responsibility.

**Customer subject — RETAINED (cannot delete):**

- `orders` → kept for 7 years per Minn. Rule 21-23. The
  `user_id` column is preserved as the now-soft-deleted user
  row's UUID; the order is still queryable by OCM, but the
  customer's name and address are scrubbed from the linked
  user / address tables.
- `order_items` → kept.
- `compliance_check_log` → kept (audit trail).
- `payment_transactions` → kept (tax + audit). The
  `provider_ref` (Aeropay charge id) remains; the
  customer-facing PII (email, name) is on the now-scrubbed
  user row.
- `metrc_receipts` → kept.
- `order_events` → kept (append-only audit log; the row that
  triggered the deletion is itself recorded here).

**Driver subject:**

- `users` row → soft-deleted as above.
- `driver_profiles` → hard-deleted.
- `driver_documents` (vehicle insurance, etc.) → hard-deleted
  after the regulatory retention period (5 years for cannabis
  delivery; the deletion may need to wait — see "Retention
  delay" below).
- `driver_locations` → hard-deleted (high-volume time-series;
  not a retention record).
- `auth_sessions` → hard-deleted.
- `background_check_status` → hard-deleted on our side. Checkr
  / Onfido retains the underlying report under their separate
  retention.

**Driver subject — RETAINED:**

- `driver_shifts` → kept for 7 years (payroll + audit).
- `orders` where this driver delivered → kept; `driver_id`
  preserved.
- `payouts` → kept (tax).
- `incident_log` → kept.

**Vendor-user subject:**

- `users` row → soft-deleted.
- `vendor_user_profiles` → hard-deleted.
- `auth_sessions` → hard-deleted.

**Vendor-user subject — RETAINED:**

- `audit_log` entries showing this user's back-office actions
  → kept (audit trail). User reference becomes
  the soft-deleted row.

#### Retention delay for drivers within the 5-year window

If a driver requests deletion before the regulatory retention
window has elapsed on their driver-documents (5 years from
last shift), the executor schedules a **delayed full deletion**
on the retention-expiry date. Between the initial deletion run
and the delayed run:

- The user is fully signed out and the consumer-facing PII is
  scrubbed.
- The driver-documents remain in encrypted storage with
  access scoped to compliance team for OCM audit only.
- A separate executor job runs on the retention-expiry date
  and hard-deletes the remaining documents.

The user is notified of the retention requirement and the
delayed-deletion timeline in the confirmation email.

### Step 5 — Send the deletion confirmation

```
Your account has been deleted.

We've removed your personal data from our systems. Some
records are kept by law:

- Your order history is retained for 7 years for cannabis
  regulatory audits (Minn. Rule 21-23) and tax purposes.
- Records of these orders are de-identified — your name,
  email, address, and phone are no longer associated.

Third parties hold separate data we don't control. To request
deletion from them, contact:

- Veriff (your ID scans): privacy@veriff.com, reference
  <session-ids>
- Aeropay (your bank link): privacy@aeropay.com
- (drivers only) Checkr or Onfido (background check):
  see the link in this email

You can re-create an account at any time with a new email.
We won't recognize you as a returning customer — your prior
order history won't link to the new account.

Thank you for using DankDash.
```

### Step 6 — Close the ticket

The Linear ticket records the deletion run timestamp. The
deletion is final. There is no undelete.

## Refusal scenarios

We may refuse or delay a deletion request when:

- **Active investigation.** A pending CS escalation (categories
  1, 2, 4, 8 from `customer-complaint-escalation.md`) — legal
  counsel approves the delay until the investigation closes.
- **Active litigation.** Litigation hold takes precedence over
  the deletion right.
- **Pending tax assessment.** IRS audit holds; the request is
  delayed until the audit closes.
- **Active OCM investigation.** OCM hold; same.

A refusal letter (`account-deletion-refusal.md` template) goes
out citing the basis. The user can appeal to the MN Attorney
General; the basis must be lawful and documented.

## Apple App Store compliance

Apple's review team will check that the in-app deletion path:

- Is reachable within the app without external navigation.
- Returns a clear in-app confirmation (not just an email).
- Does not require the user to call support to initiate.
- Honors the request within a "reasonable timeframe" — Apple
  has not defined this numerically; the 14-day cooling-off
  plus same-day suspension is widely accepted.

The in-app form has been reviewed against the
[App Store Review Guidelines 5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/#5.1.1)
checkpoints. The QA suite has a smoke test that verifies the
form is reachable from Settings → Account → Delete account.

## Postmortem template

Not normally applicable. For exceptional cases (refused requests
escalating to AG complaints, deletion that uncovered a
data-classification bug, deletion that revealed retention drift),
file a process note under
`docs/compliance/privacy/exceptional-deletions/YYYY-MM-<linear-id>.md`
for legal counsel review.
