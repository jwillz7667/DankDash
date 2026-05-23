# Legal documents

This directory holds the customer- and partner-facing legal
documents for DankDash. Each file is a **first draft** intended
as a starting point for outside counsel review, not as a
counsel-signed document.

Every file in this directory carries one or more
`[REVIEW WITH COUNSEL]` markers at sections that require
lawyer sign-off before publication. Do not publish or link to
these documents from any production surface (consumer app,
vendor portal, driver app, marketing site) until those markers
have been cleared.

## Files

| File                                                                         | Audience           | Notes                                                                                          |
| ---------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| [`terms-of-service.md`](./terms-of-service.md)                               | Consumers          | The clickwrap users see at account creation.                                                   |
| [`privacy-policy.md`](./privacy-policy.md)                                   | Consumers          | The privacy notice required by MN § 325O, Apple App Store policy 5.1.1, GDPR Art. 13.          |
| [`vendor-agreement.md`](./vendor-agreement.md)                               | Dispensaries       | The contract every partner dispensary signs to list on DankDash.                               |
| [`driver-agreement.md`](./driver-agreement.md)                               | Drivers            | The independent-contractor agreement every DankDasher driver signs.                            |
| [`cannabis-compliance-disclosures.md`](./cannabis-compliance-disclosures.md) | Consumers (inline) | The age-gate / state-restriction / responsible-use disclosures shown at age gate and checkout. |

## Format conventions

- Plain markdown so reviewers can comment line-by-line in a PR.
- Sections numbered for easy citation in counsel feedback.
- US English. Date format `YYYY-MM-DD`. Currency `USD` written
  in full at first reference.
- Defined terms ("DankDash", "User", "Dispensary Partner",
  "Driver") capitalized; defined the first time they are used.
- `[REVIEW WITH COUNSEL]` is the explicit sign-off marker.
  `[FACT-CHECK]` is for items that need engineering /
  operations confirmation. `[OPEN ISSUE]` is for items the
  drafter is uncertain about and explicitly flagging.

## Out of scope of this directory

- HIPAA notices (we are not a covered entity).
- Investor / corporate documents (separate repository,
  counsel-held).
- Tax / IRS records (separate retention).
- Apple Developer Program License Agreement (Apple-managed).

## How these surface to users

Once counsel has signed off and the `[REVIEW WITH COUNSEL]`
markers are cleared, each document is published to:

- **Terms of Service**, **Privacy Policy**, **Cannabis
  Compliance Disclosures** — rendered at `dankdash.com/legal/*`
  by the marketing site, linked from the consumer iOS app's
  Settings → About screen, and linked from the age-gate
  acknowledgement screen.
- **Vendor Agreement** — bundled into the vendor onboarding
  wizard (Phase 22.4 — deferred per ADR
  `0009-phase22-prelaunch.md` until portal scaffolding lands).
- **Driver Agreement** — bundled into the driver onboarding
  flow inside DankDasher.

Publication touches several systems (DocuSign for the
counter-signed vendor / driver agreements, the marketing site
CDN for the consumer-facing docs). The mechanics live in the
launch checklist.
