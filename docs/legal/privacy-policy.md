# Privacy Policy

**DRAFT — `[REVIEW WITH COUNSEL]` before publication.**

Effective date: [TO BE SET AT PUBLICATION]
Last updated: [TO BE SET AT PUBLICATION]

This Privacy Policy describes how DankDash, Inc.
(**"DankDash"**, **"we"**, **"us"**, **"our"**) collects, uses,
shares, and protects personal information when you use the
DankDash consumer iOS application and the
[www.dankdash.com](https://www.dankdash.com) website (the
**"Service"**). It applies to information about Users of the
Service. Separate notices apply to Dispensary Partner staff
(see the Vendor Agreement) and to Drivers (see the Driver
Agreement).

This policy is designed to comply with:

- Minnesota Consumer Data Privacy Act, Minn. Stat. § 325O
- Apple App Store policy 5.1.1 (data collection disclosure)
- General Data Protection Regulation (EU GDPR), where
  applicable to Minnesota residents who use the Service from
  the EU or are EU citizens.

`[REVIEW WITH COUNSEL]` — also assess California (CCPA/CPRA)
applicability if any User base may include California
residents. The current launch geography is Minnesota-only,
but residency and use-location are not the same thing.

## 1. Information we collect

### 1.1 Information you provide

- **Account information.** Email address, phone number, full
  name, date of birth.
- **Identity verification.** A photo of your government-issued
  ID and a selfie liveness check, processed by our identity
  verification provider Veriff. The image itself is held by
  Veriff; we retain only the verification outcome and the
  Veriff session reference.
- **Payment information.** Bank account details for ACH
  transfer, collected and stored by our payment processor
  Aeropay. We retain only a tokenized reference; the underlying
  account number is held by Aeropay.
- **Delivery address.** Street address, unit number,
  delivery instructions.
- **User-generated content.** Reviews, dispensary ratings,
  customer-support correspondence.

### 1.2 Information about your use of the Service

- **Order history.** Products ordered, prices paid, dispensary
  partners, dates, delivery addresses.
- **Device and app data.** Device model, iOS version, app
  version, IP address, language, time zone, push-notification
  token. Used for security and product analytics.
- **Location.** Precise location at delivery time (for
  geofence verification); precise location while browsing
  (only with your explicit OS-level permission). Location data
  is **not** continuously tracked.
- **Crash and error reports.** Stack traces and app state
  surrounding crashes; routed to Sentry. PII is redacted at
  the SDK level.
- **Analytics.** Event-level interaction data (which screens
  you view, which products you tap, time-on-screen). Used to
  improve the Service.

### 1.3 Information from third parties

- **Identity verification result** from Veriff: pass / fail
  / requires-review, with no underlying biometric data.
- **Background check status** (drivers only — not applicable
  to Users of the consumer Service).
- **Bank-account verification** from Aeropay: linked / unlinked.

## 2. How we use information

We use personal information to:

- (a) operate the Service (build your cart, evaluate compliance,
  process payments, dispatch a Driver, track delivery, generate
  receipts);
- (b) verify your age and identity as required by Minn. Stat.
  § 342.27 and Apple App Store policy;
- (c) report sales to OCM via Metrc as required by Minn. Rule
  21-23;
- (d) provide customer support and respond to your inquiries;
- (e) protect against fraud, abuse, and underage purchases;
- (f) improve the Service through analytics;
- (g) comply with legal obligations, including tax reporting
  and regulatory audit response;
- (h) communicate with you about orders, account changes, and
  (with your consent) product updates and marketing.

We **do not** use personal information for:

- Targeted advertising on third-party platforms.
- Sale of personal information to data brokers.
- Behavioral profiling beyond product improvement.
- Any use prohibited by Apple App Store policy or applicable
  law.

`[REVIEW WITH COUNSEL]` — the "do not" list is the
disclosure-driven posture; if marketing wishes to do any of
these in the future, this section must be updated and Users
re-notified.

## 3. How we share information

### 3.1 With Dispensary Partners

When you place an order, the Dispensary Partner receives:
your first name and last-initial, your delivery address,
your phone number (for delivery coordination), and the
contents of your order. They do **not** receive your DOB,
ID-scan images, full name, or payment information.

### 3.2 With Drivers

The Driver assigned to your order receives:
your first name and last-initial, your delivery address,
your phone number (for delivery coordination), the order
contents (for verification at delivery), and a record that
ID verification is required at handoff. They do **not** see
your DOB or payment information; they verify your ID at
delivery by inspecting the physical document.

### 3.3 With service providers

- **Aeropay** — for ACH payment processing.
- **Veriff** — for identity verification.
- **Twilio** — for SMS notifications.
- **AWS / Cloudflare** — for hosting and CDN.
- **Sentry / Grafana / Datadog** — for monitoring and crash
  reporting (PII-redacted).
- **Linear** — for customer-support ticket management
  (limited User identifiers only).

Each service provider is bound by a data processing agreement
that limits their use of personal information to what is
necessary to provide their service to us.

### 3.4 With regulators

We are required by Minnesota cannabis law to report every
delivered order to OCM via the Metrc system. Reported fields
include the dispensary license, package tag, quantity, and
de-identified age-verification confirmation. We do **not**
report your full name or address to OCM as part of routine
reporting; OCM may request the underlying records during an
audit (see `docs/runbooks/license-compliance-audit.md`).

We will comply with valid subpoenas, warrants, and lawful
information requests. Where permitted, we will notify you
before producing your information in response to legal
process.

### 3.5 In corporate transactions

If DankDash is acquired, merged, or assigns its assets, your
information may transfer to the acquirer subject to this
Privacy Policy. We will notify you and give you the
opportunity to delete your account before the transfer takes
effect, where reasonably feasible.

### 3.6 With your consent

For anything not described above, we will ask before sharing.

## 4. Cookies and similar technologies

The Service uses minimal cookies and analytics SDKs. We do
not use third-party advertising cookies. The full inventory:

- Session cookie on `dankdash.com` (essential — no analytics).
- Auth cookies on `checkout.dankdash.com` (essential for
  checkout hand-off).
- Sentry SDK on iOS app (crash reporting; PII redacted).
- First-party analytics on iOS app (event-level, anonymized
  device ID).

We do not currently surface a cookie banner because all
cookies in use are essential or first-party analytics that
do not require consent under MN law. `[REVIEW WITH COUNSEL]`
— confirm GDPR posture for any EU-resident user reaches a
cookie banner.

## 5. Your rights

If you are a Minnesota resident (or, where applicable, an EU
resident under GDPR), you have the right to:

- **Access** — request a copy of the personal information we
  hold about you. Operational procedure:
  `docs/runbooks/data-export-request.md`. SLA: 30 days from
  verified request.
- **Correct** — request correction of inaccurate information.
  Most fields can be edited in-app under Settings → Account.
- **Delete** — request erasure of your account and personal
  information. Operational procedure:
  `docs/runbooks/account-deletion-request.md`. Note: some
  records are retained by law (cannabis sale records, tax
  records); the retention basis is explained at deletion time.
- **Port** — receive a machine-readable copy of your
  information for transfer elsewhere. (Same procedure as
  Access; the export is JSON.)
- **Object to processing** — for processing where the legal
  basis is "legitimate interest." Request via
  privacy@dankdash.com.
- **Opt out of marketing** — unsubscribe link in every
  marketing email; in-app toggle under Settings → Notifications.
- **Non-discrimination** — we will not deny you service,
  charge you more, or provide a lower-quality service for
  exercising your privacy rights.

To exercise these rights, use the in-app form (Settings →
Privacy) or email privacy@dankdash.com. We verify the
requester's identity before honoring any rights request.

You also have the right to file a complaint with the
Minnesota Attorney General's office or, where applicable,
your EU supervisory authority.

## 6. Retention

We retain personal information only as long as needed:

- **Account data** — kept while your account is active.
  Deleted (or de-identified) 14 days after deletion request,
  subject to retention exceptions below.
- **Order records** — retained for **7 years** as required
  by Minn. Rule 21-23 (cannabis sale recordkeeping) and IRS
  rules. After 7 years, the records are aggregated into
  statistics and the individual identifiers are removed.
- **ID verification result** — retained for 7 years. The
  underlying image is held by Veriff under their separate
  retention policy.
- **Driver location** — retained for 90 days, then deleted.
- **Analytics events** — retained for 25 months, then deleted.
- **Crash reports** — retained for 90 days, then deleted.
- **Customer-support correspondence** — retained for 3 years
  for support-quality purposes, then deleted.

## 7. Security

We use industry-standard administrative, technical, and
physical safeguards to protect personal information:

- TLS 1.3 for all data in transit.
- AES-256 encryption at rest for the database, with column-level
  encryption for **Restricted** classification fields (DOB, ID
  document numbers, scan image references, bank refs, MFA
  secrets — see the spec for the full classification map).
- Role-based access controls, with row-level security at the
  database layer for Dispensary Partner data isolation.
- Multi-factor authentication required for all employees and
  contractors with production data access.
- Annual penetration testing by an independent third party.
- Continuous vulnerability scanning of dependencies; high or
  critical CVEs block deploys.

No security system is impenetrable. If we determine a security
incident has affected your personal information, we will
notify you and, where required, the Minnesota Attorney General,
in accordance with Minn. Stat. § 325E.61 (data breach
notification).

`[REVIEW WITH COUNSEL]` — confirm the breach-notification
timeline language matches MN statutory requirements.

## 8. Children's privacy

The Service is **not intended for anyone under 21**, the
legal age for adult-use cannabis in Minnesota. We do not
knowingly collect personal information from anyone under 21.
The age gate at account creation is the primary control. If
we learn that we have collected personal information from a
minor, we will delete that information immediately.

If you believe a minor has provided information to us,
contact privacy@dankdash.com.

## 9. International transfers

DankDash operates in the United States. Our service providers
are primarily in the United States. If you access the Service
from outside the United States, you consent to the transfer of
your information to the United States, which may have different
data protection laws than your country of residence.

`[REVIEW WITH COUNSEL]` — if GDPR applies (EU residents
using the service), the appropriate transfer mechanism
(Standard Contractual Clauses) should be in our contracts with
Aeropay, Veriff, and Twilio.

## 10. Changes to this Policy

We may update this Privacy Policy from time to time. We will
notify you of material changes by email (if you have an
account) and in-app on next launch. The "Last updated" date
at the top of this Policy reflects the effective date of the
most recent change.

## 11. Contact

DankDash, Inc.
[REGISTERED ADDRESS] `[FACT-CHECK]`
[privacy@dankdash.com](mailto:privacy@dankdash.com)

Data Protection Officer (where required by GDPR):
[NAME / EMAIL — TO BE APPOINTED] `[OPEN ISSUE]`

---

`[REVIEW WITH COUNSEL]` — overall review of:

- "Categories of personal information" disclosure required
  under Minn. § 325O (Section 1 covers but a tabular
  summary may be more compliant).
- "Sources of personal information" required disclosure.
- "Purposes" disclosure required.
- "Third parties with which we share" required disclosure.
- "Sensitive personal information" handling (cannabis-purchase
  history may qualify as sensitive in some jurisdictions).
- Whether biometric data is in scope (Veriff returns a yes/no;
  the biometric template stays with them).
- Apple App Store nutrition-label alignment (the privacy
  label submitted in App Store Connect must match this
  document).
