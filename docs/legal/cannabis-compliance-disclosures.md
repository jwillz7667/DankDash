# Cannabis Compliance Disclosures

**DRAFT — `[REVIEW WITH COUNSEL]` before publication.**

Effective date: [TO BE SET AT PUBLICATION]
Last updated: [TO BE SET AT PUBLICATION]

This document collects the legally required and operationally
prudent **consumer-facing disclosures** that DankDash, Inc.
(**"DankDash"**) shows to users of the consumer iOS app and
the `www.dankdash.com` website (the **"Service"**). Each
disclosure is reproduced here in the form it appears in the
Service, with cross-references to the screen / surface where
it is shown.

These disclosures are **separate from** the Terms of Service
and the Privacy Policy. They focus on the cannabis-specific
warnings, age-gate, federal-state conflict acknowledgment,
and responsible-use information that Minnesota cannabis law,
Apple App Store policy 5.1.1, and prudent operating practice
require to be surfaced to the user.

`[REVIEW WITH COUNSEL]` — confirm that the exact placement
and wording of each disclosure meets:

- Minn. Stat. § 342.63 (consumer notice requirements at
  point of sale) `[FACT-CHECK — exact subsection]`;
- Minn. Rule 21-23 advertising and labeling rules where
  they apply to consumer disclosures;
- Apple App Store Review Guidelines 1.4.3 (age-gate
  posture) and 5.1.1 (privacy disclosures);
- The OCM bulletins on responsible-use messaging current
  as of execution.

## Index

| #   | Disclosure                              | Surface(s)                     |
| --- | --------------------------------------- | ------------------------------ |
| 1   | Age gate                                | App first-launch, web entry    |
| 2   | Federal / state law conflict            | Onboarding, About screen       |
| 3   | Minnesota-only restriction              | Onboarding, Checkout, Receipt  |
| 4   | Sale-hour restriction                   | Checkout, "store closed" empty |
| 5   | Per-transaction limits                  | Cart, Checkout                 |
| 6   | Responsible-use & impairment warning    | Checkout, Receipt              |
| 7   | Keep out of reach of children / animals | Receipt, in-app product detail |
| 8   | Do not drive / operate machinery        | Checkout, Receipt              |
| 9   | Pregnancy and breastfeeding warning     | Product detail, Checkout       |
| 10  | Adverse reaction reporting              | Receipt, Help                  |
| 11  | Resources for problematic use           | Receipt, Settings → Resources  |

## 1. Age Gate

Shown on first launch of the app, before any other content,
and on entry to the website at `dankdash.com`.

> # You must be 21+ to use DankDash
>
> Minnesota law restricts the sale of cannabis to adults
> 21 years of age and older. By continuing, you confirm
> that you are at least 21 years old and a Minnesota
> resident.
>
> [I am 21 or older] [Exit]

The "Exit" button on iOS closes the app on first launch;
on web it redirects to a public marketing page that does
not include any product information.

Behind the scenes, the age check is enforced again at
account creation by collecting the user's date of birth and
performing the verifiable age check against the
government-issued ID supplied during identity verification
(see the Privacy Policy, Section 1.1).

`[REVIEW WITH COUNSEL]` — confirm whether a pure
self-declaration age gate is sufficient under Minn. Rule
21-23 for the marketing surface, given that the actual
purchase flow does require verifiable ID. Apple's 5.1.1
position has historically accepted self-declaration plus
later verification.

## 2. Federal / State Law Conflict

Shown during onboarding (immediately after the age gate),
and accessible at any time from Settings → About →
Important Notices.

> ### Cannabis remains federally controlled
>
> Cannabis is legal in Minnesota for adults 21+ under
> Minn. Stat. § 342, but it remains a Schedule I controlled
> substance under federal law. This may affect:
>
> - Travel across state lines (do not cross any state border
>   with cannabis product, even to another legal state).
> - Federal employment, housing, and benefit programs.
> - Firearms-related federal forms (ATF Form 4473).
> - Immigration status.
> - Banking and financial services.
>
> This conflict is real and may not be resolved at the time
> you use the Service. By using DankDash, you acknowledge
> these federal risks and accept them as your own.
>
> [I understand]

This screen is dismissible by tapping "I understand" and is
not re-shown unless the user reinstalls the app, clears
local data, or the disclosure version increments.

## 3. Minnesota-Only Restriction

The DankDash service is offered **only to Minnesota
residents at Minnesota delivery addresses**. The restriction
is surfaced in three places:

### 3.1 Onboarding

> ### Service available in Minnesota only
>
> DankDash currently delivers only within Minnesota.
> If you live outside Minnesota, please come back when we
> expand to your state.

### 3.2 Address entry

If a user enters a non-Minnesota address at checkout:

> Sorry — we can't deliver to addresses outside Minnesota.
> Federal law prohibits transporting cannabis across state
> lines, even between two states where adult-use cannabis
> is legal.

The address-entry screen rejects the address; the user
cannot proceed.

### 3.3 Receipt

Every receipt includes the line:

> Delivered within Minnesota under Minn. Stat. § 342.

## 4. Sale-Hour Restriction

Minnesota allows adult-use cannabis sales between 8:00 AM
and 2:00 AM local time. Dispensary Partners may set narrower
hours.

### 4.1 Checkout (outside sale hours)

When a user attempts checkout outside permitted hours:

> Sales are not currently available
>
> We can accept orders between [DISPENSARY OPEN] and
> [DISPENSARY CLOSE] local time. Your cart is saved and
> will be ready when sales resume.

### 4.2 Storefront (outside hours)

> [Dispensary Name] is currently closed
>
> Opens at [TIME] today. You can browse the menu now —
> ordering becomes available at opening.

## 5. Per-Transaction Limits

Minn. Stat. § 342.27 limits the amount of cannabis that may
be purchased in a single transaction:

- Flower: **56.7 g** (2.0 oz)
- Concentrate: **8 g**
- Edible THC: **800 mg**
- Cannabis-infused beverage: **≤ 10 mg THC per serving**,
  **≤ 2 servings per container**

### 5.1 Cart progress bar

A live progress bar shows the user how close they are to
each applicable limit. Approaching a limit (>80%):

> You're approaching the Minnesota per-transaction limit for
> [category]. [Used] g / [Limit] g.

At limit:

> This item would exceed Minnesota's per-transaction limit
> for [category]. To proceed, remove items in that category.

### 5.2 Checkout block

If a checkout fails the server-side compliance check (which
re-runs the limit calculation authoritatively):

> Order can't be placed
>
> Minnesota per-transaction limits prevent this order from
> being placed:
>
> - [Reason 1 with the limit and the cart amount]
> - [Reason N]
>
> Adjust your cart and try again. (Statute: Minn. Stat. §
> 342.27.)

Each block includes the statutory citation so the user can
verify the source.

## 6. Responsible-Use & Impairment Warning

Shown on the checkout review screen (above the place-order
button), on the order confirmation screen, and on the
receipt.

> ### Use responsibly
>
> Cannabis affects people differently. Start low and go
> slow — especially with edibles, which can take up to two
> hours to take effect.
>
> Do not consume more than you intend to. The strength of
> edibles is shown in milligrams of THC; if you are new to
> edibles, 2.5–5 mg is a common starting dose.
>
> Cannabis can cause anxiety, paranoia, impaired memory,
> impaired coordination, and rapid heartbeat. If you
> experience symptoms that concern you, contact a poison
> control center (1-800-222-1222) or call 911 for emergency
> medical help.

`[REVIEW WITH COUNSEL]` — confirm the 2.5–5 mg starting-dose
language is consistent with current MDH and OCM consumer
guidance; both have published edible-dosing guidance in
2024 and 2025.

## 7. Keep Out of Reach of Children and Animals

Shown on every product detail screen (in a persistent footer)
and on every receipt.

> ⚠ Keep cannabis products out of reach of children and pets.
> Accidental ingestion can require emergency medical care.
> Store in a locked or otherwise inaccessible location in
> original child-resistant packaging.

If an animal ingests:

> If your pet has ingested cannabis, contact your
> veterinarian or the ASPCA Animal Poison Control Center
> at 1-888-426-4435.

## 8. Do Not Drive or Operate Machinery

Shown at checkout review and on the receipt.

> ### Do not drive or operate machinery while impaired
>
> Driving under the influence of cannabis is illegal in
> Minnesota and dangerous. Cannabis impairment can last
> longer than you feel it — especially with edibles.
>
> Plan a safe ride home before consuming. If you need to
> drive, do not consume.

## 9. Pregnancy and Breastfeeding Warning

Shown on every product detail screen for ingestible products
and on the checkout review.

> ### Not for use during pregnancy or breastfeeding
>
> THC and other cannabinoids can cross the placenta and
> are present in breast milk. Use during pregnancy or
> breastfeeding may harm a developing fetus or infant. If
> you are pregnant, planning to become pregnant, or
> breastfeeding, consult your healthcare provider before
> using cannabis products.

## 10. Adverse Reaction Reporting

Shown on every receipt under the "If something goes wrong"
section, and on the in-app Help screen.

> ### Adverse reactions
>
> If you experience an adverse reaction to a product
> ordered through DankDash, please:
>
> 1. **Seek medical care immediately** if you are in
>    physical distress. Call 911 for emergencies, or Poison
>    Control at 1-800-222-1222.
> 2. **Tell us** at safety@dankdash.com or in the in-app
>    Help → Report an issue form. Include the order
>    number and a description of what happened.
> 3. **Report to the state** at the Minnesota Department
>    of Health adverse-event line:
>    [HEALTH.MN.GOV/CANNABIS-ADVERSE] `[FACT-CHECK]`
>
> We take adverse-reaction reports seriously. We forward
> safety reports to the originating Dispensary Partner and,
> where required, to OCM.

The in-app form is the canonical path. See the
`customer-complaint-escalation` runbook for the operational
response.

## 11. Resources for Problematic Use

Shown on the receipt and in Settings → Resources.

> ### Resources for problematic cannabis use
>
> If your or someone you know is having trouble with
> cannabis use, help is available:
>
> - **Minnesota Helpline** — 1-800-662-HELP (4357)
>   (free, confidential, 24/7) — SAMHSA's National Helpline.
> - **Minnesota Department of Human Services Behavioral
>   Health** — mn.gov/dhs/people-we-serve/adults/health-care/behavioral-health
>   `[FACT-CHECK]`
> - **National Cannabis Use Disorder hotline** —
>   1-800-662-4357
>
> If you'd like, we can pause your account. Go to Settings
> → Account → Take a break.

The "Take a break" feature suspends the user's account for
a self-selected period (7 / 30 / 90 / 365 days). During
the pause, the user cannot place orders, but the account
itself is preserved.

`[REVIEW WITH COUNSEL]` — confirm the SAMHSA hotline number
is the appropriate primary referral; some operators use a
state-specific helpline. Verify any state-specific number
before publication.

## 12. Allergens

Cannabis products may contain or be processed with common
allergens (nuts, dairy, soy, gluten, sesame, eggs). Each
product listing surfaces the allergen statement provided by
the Dispensary Partner and the manufacturer's certificate
of analysis (COA).

Where the COA reports an allergen, the product card
displays:

> ⚠ Contains [allergen list]
>
> Manufactured in a facility that processes [shared-line
>
> > allergens, where disclosed].

DankDash does not audit allergen statements at intake.
Users with severe allergies should consult the
manufacturer-provided COA linked from each product page.

## 13. Lab Results / Certificates of Analysis

Each product page links to the most recent independent
laboratory certificate of analysis (COA) supplied by the
manufacturer. The COA shows cannabinoid content (THC, CBD,
total cannabinoids), terpene profile, and contaminant
testing (pesticides, residual solvents, heavy metals,
microbial).

If a product's COA is missing, expired (>180 days), or
flagged for a contaminant exceedance, the product cannot
be listed for sale. See the catalog-admission runbook
`[FACT-CHECK — confirm filename when written]`.

## 14. Disclosure Version Tracking

Each disclosure carries a version. When DankDash updates a
disclosure, the version increments and the user is shown
the new disclosure the next time they enter the relevant
screen.

The version table is maintained at
`packages/compliance/src/disclosures/versions.ts`
`[FACT-CHECK — confirm filename when written]`.

Records of which disclosure version each user has seen are
retained for 7 years (matching the cannabis-records
retention period in the Privacy Policy, Section 6).

---

`[REVIEW WITH COUNSEL]` — overall review of:

- Whether each disclosure satisfies the cannabis-specific
  point-of-sale notice rules of Minn. Stat. § 342.63 (or
  the cited correct subsection).
- Whether the federal / state conflict notice adequately
  protects against state-tort failure-to-warn claims.
- Whether the responsible-use and dosing language is
  consistent with the most recent OCM bulletins.
- Whether the do-not-drive warning is sufficient to invoke
  contributory-negligence defenses if a user drives
  impaired after ordering.
- Apple App Store privacy-label and 1.4.3-age-gate
  alignment — the app-side wording must match the App
  Store submission metadata.
- Sufficiency of the adverse-event reporting flow to
  invoke the safe harbor (if any) under Minnesota's
  consumer-safety reporting law.
- Coordination of these disclosures with the parallel
  receipt-side disclosures we file with OCM via Metrc
  (some of the same warning language is required on the
  package itself, by the manufacturer, not by DankDash).
