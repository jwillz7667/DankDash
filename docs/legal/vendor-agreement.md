# DankDash Vendor Agreement

**DRAFT — `[REVIEW WITH COUNSEL]` before any partner
counter-signature.**

This DankDash Vendor Agreement (the **"Agreement"**) is
entered into between DankDash, Inc., a Delaware corporation
("**DankDash**"), and the cannabis retailer named on the
signature page of this Agreement (the **"Vendor"**). The
Agreement is effective as of the date the Vendor counter-signs
(the **"Effective Date"**).

`[REVIEW WITH COUNSEL]` — confirm DankDash entity name,
state of incorporation, signature-page structure, and the
signatory-authority representation language.

## 1. The arrangement

1.1 DankDash operates a technology platform that connects
consumers ("**Users**") with licensed Minnesota cannabis
retailers and arranges independent-contractor delivery of
cannabis products from the retailer to the User (the
"**Service**"). The Service is described in more detail at
[www.dankdash.com](https://www.dankdash.com) and in the
DankDash consumer iOS application.

1.2 Under this Agreement, DankDash will:

- (a) list the Vendor's catalog on the Service, including
  product information, pricing, and availability;
- (b) accept orders from Users on the Vendor's behalf;
- (c) arrange for an independent-contractor Driver to collect
  the Vendor's prepared order from the Vendor's licensed
  premises and deliver it to the User;
- (d) process payments from the User to the Vendor (less
  applicable fees) via the DankDash payment processor;
- (e) provide order tracking, customer support, and reporting
  to the Vendor.

  1.3 Under this Agreement, the Vendor will:

- (a) maintain a valid Minnesota cannabis retailer license
  for the duration of this Agreement;
- (b) keep the Vendor's catalog accurate and up to date on
  the Service;
- (c) prepare each order in accordance with the User's cart
  and within the time window agreed in the Vendor's
  preparation-time setting;
- (d) hand off prepared orders to the assigned Driver in
  compliance with chain-of-custody requirements;
- (e) submit the required reports to OCM via Metrc for each
  delivered order (using the integration DankDash provides);
- (f) honor the prices, taxes, and fees displayed to the
  User at checkout.

`[REVIEW WITH COUNSEL]` — clarify whether the Vendor or
DankDash is the Metrc reporting party of record. The
spec assumes DankDash submits on the Vendor's behalf using
the Vendor's facility credentials; if the Vendor is the
party of record, language must shift.

## 2. The Vendor's representations and warranties

The Vendor represents and warrants, on the Effective Date and
on each day this Agreement is in effect:

2.1 The Vendor holds a valid Minnesota cannabis retailer
license issued by OCM under Minn. Stat. Chapter 342, and the
license is in good standing.

2.2 The Vendor's principals, owners, and managers have passed
all OCM-required background checks and are not on any
applicable federal or state debarment or sanctions list.

2.3 All cannabis products sold through the Service have been
sourced from licensed Minnesota cultivators, manufacturers,
or wholesalers in compliance with Minn. Rule 21-23, with
Metrc package tags traceable to a tested lot.

2.4 The Vendor's catalog as listed on the Service is
accurate, including product names, descriptions, weights,
THC content per unit, CBD content per unit, allergen
disclosures, and prices.

2.5 The Vendor maintains insurance coverage in commercially
reasonable amounts, including product liability insurance
specific to cannabis products, naming DankDash as additional
insured.

`[REVIEW WITH COUNSEL]` — set specific insurance minimums
(general liability, product liability, employer's liability,
auto, cyber). The values vary by jurisdiction and Vendor
size; counsel sets the floor.

2.6 The Vendor's employees who interface with the Service
(catalog management, order acceptance, hand-off) are at
least 21 years of age and have completed the OCM-required
responsible-vendor training.

## 3. Pricing, payments, and fees

3.1 The Vendor sets the retail price of each cannabis
product. DankDash does not control retail prices.

3.2 Sales tax and the Minnesota cannabis gross receipts tax
(Minn. Stat. § 295.81, currently 10%) are added at checkout
and remitted by the Vendor to the Minnesota Department of
Revenue. DankDash facilitates the collection on the
Vendor's behalf and reports the collected amount on the
Vendor's monthly settlement report.

3.3 DankDash retains the **DankDash Platform Fee** equal to
[X]% of the cannabis-product subtotal for each delivered
order. `[REVIEW WITH COUNSEL]` — set %.

3.4 The Vendor pays the **Driver delivery fee** to DankDash
for each delivered order. The delivery fee is set by
DankDash and disclosed in the Vendor portal. DankDash
remits the delivery fee to the Driver.

3.5 DankDash settles with the Vendor weekly. Each settlement
covers orders delivered (or finally canceled) between
Sunday 00:00:00 America/Chicago and the following Saturday
23:59:59 America/Chicago. The settlement payment is made by
ACH on the second business day after the close of the
settlement period.

3.6 The settlement report lists, per order: the User-paid
total, the cannabis-product subtotal, the sales and excise
taxes collected (remitted to the Vendor for tax
remittance), the DankDash Platform Fee, the Driver delivery
fee, the User-paid tip (if any; passed through entirely to
the Driver, not the Vendor), any applicable discounts, and
the net amount paid to the Vendor.

`[REVIEW WITH COUNSEL]` — the settlement-and-tax flow needs
counsel review. The model assumes the Vendor remits sales
tax; some models have the platform remit on the Vendor's
behalf under a marketplace-facilitator construction. Minn.
Department of Revenue has guidance.

3.7 **Refunds.** If the Vendor authorizes a refund (in
response to a customer complaint, wrong item, etc.), the
refund amount is debited from the Vendor's next settlement.
Refunds processed by DankDash on behalf of the Vendor
(under the Refund Authority Matrix in
`docs/runbooks/customer-complaint-escalation.md`) are
likewise debited.

## 4. Compliance

4.1 The Vendor is responsible for ensuring that each order it
fulfills complies with applicable Minnesota cannabis law,
including:

- (a) the per-transaction limits in Minn. Stat. § 342.27;
- (b) the sale-hour restrictions (8:00 AM – 2:00 AM local);
- (c) the THC-beverage container limits;
- (d) the COA recordkeeping requirements.

  4.2 DankDash operates a server-side compliance engine that
  verifies each cart against the requirements in Section 4.1
  before checkout. The engine is the **first** check, not the
  only check; the Vendor remains responsible for verifying
  compliance at the point of order acceptance.

  4.3 The Vendor will record every delivered sale in Metrc
  within the OCM-required reporting window (currently 24
  hours). DankDash automates the Metrc submission using the
  Vendor's facility credentials; the Vendor remains
  responsible for the accuracy of the report and for resolving
  any rejection notices from Metrc.

  4.4 The Vendor will not list, and will remove on receipt of
  notice from DankDash, any product that DankDash determines
  violates Section 4.1 or any applicable law.

## 5. Driver handoff

5.1 The Vendor will hand off each prepared order to the
assigned Driver only after the Vendor's staff has confirmed:

- (a) the order contents match the User's cart;
- (b) each package carries the correct Metrc package tag;
- (c) the package is properly sealed in compliance with
  Minn. Rule 21-23 packaging requirements;
- (d) the Driver presents the correct order verification code
  (a 6-digit code displayed on the Driver's app, matched to
  the order).

  5.2 The Vendor will record the hand-off (Driver name, time
  of hand-off, order ID) in the DankDash Vendor portal. The
  hand-off record is the chain-of-custody artifact for OCM
  audit purposes.

  5.3 If no Driver arrives within the agreed pickup window,
  or if the Vendor declines to release the order to the
  Driver for any reason, the Vendor must notify DankDash
  within 15 minutes via the in-portal escalation flow.

## 6. Catalog

6.1 The Vendor maintains its catalog in the Vendor portal.
Updates propagate to the User-facing Service within 30
seconds of save.

6.2 The Vendor warrants the catalog is free of:

- (a) misrepresentation of product effects or therapeutic
  claims;
- (b) imagery that depicts cartoon characters, celebrities,
  or anything that could appeal to minors;
- (c) language that implies a health benefit or treatment
  for any disease.

`[REVIEW WITH COUNSEL]` — OCM advertising rules under Minn.
Rule 21-23 are specific and evolving. Confirm Section 6.2
maps to current rules.

## 7. Data and intellectual property

7.1 DankDash does not claim ownership of the Vendor's
catalog content; the Vendor grants DankDash a worldwide,
royalty-free, non-exclusive license to display the catalog
through the Service.

7.2 DankDash owns the Service, including its software,
design, and platform-level content. The Vendor receives no
rights in the Service beyond what this Agreement grants.

7.3 The Vendor will not scrape, harvest, or otherwise
extract data from the Service beyond what the Vendor's
ordinary use generates.

7.4 The Vendor agrees that **User data** (orders, delivery
addresses, phone numbers) is shared with the Vendor only
for the purpose of fulfilling the order. The Vendor will
not:

- (a) re-market to Users outside the DankDash channel;
- (b) sell or transfer User data to any third party;
- (c) retain User data beyond what is required for tax,
  regulatory, or refund-window purposes.

`[REVIEW WITH COUNSEL]` — the Vendor-side data-use
restriction may need to be a formal Data Processing
Agreement (DPA) appendix.

## 8. Indemnification

8.1 The Vendor indemnifies and holds harmless DankDash from
any claim arising out of:

- (a) the Vendor's breach of this Agreement;
- (b) any product liability claim related to a cannabis
  product the Vendor sold through the Service;
- (c) any regulatory action against the Vendor;
- (d) any inaccuracy in the Vendor's catalog or in any Metrc
  report attributable to the Vendor.

  8.2 DankDash indemnifies and holds harmless the Vendor from
  any claim arising out of DankDash's gross negligence or
  willful misconduct in operating the Service, subject to
  the limitation of liability in Section 11.

## 9. Term and termination

9.1 The term of this Agreement begins on the Effective Date
and continues until terminated under this Section 9.

9.2 Either party may terminate this Agreement on **30 days
written notice** for any reason.

9.3 Either party may terminate immediately on written notice
if:

- (a) the other party materially breaches and fails to cure
  within 10 business days of notice;
- (b) the other party files for bankruptcy or becomes
  insolvent;
- (c) for DankDash: the Vendor's cannabis license is
  suspended, revoked, or expires;
- (d) for the Vendor: DankDash ceases operation of the
  Service in Minnesota.

  9.4 Upon termination:

- (a) the Vendor's catalog is removed from the Service;
- (b) in-flight orders complete (DankDash will not accept
  new orders for the Vendor);
- (c) the final settlement payment is made within 30 days;
- (d) the data-handling obligations in Section 7 survive.

## 10. Confidentiality

Each party will hold in confidence the non-public
information disclosed by the other in connection with this
Agreement and use it only to perform under this Agreement.
This obligation survives termination for **3 years**.

## 11. Limitation of liability

11.1 IN NO EVENT WILL EITHER PARTY BE LIABLE FOR ANY
INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, OR
ANY LOST PROFITS OR REVENUES, ARISING OUT OF THIS AGREEMENT,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

11.2 IN NO EVENT WILL DANKDASH'S AGGREGATE LIABILITY TO THE
VENDOR ARISING OUT OF THIS AGREEMENT EXCEED THE GREATER OF
(a) THE AGGREGATE FEES PAID BY THE VENDOR TO DANKDASH IN THE
TWELVE MONTHS PRECEDING THE CLAIM, OR (b) [$X]. `[REVIEW
WITH COUNSEL]` — set $.

11.3 Section 11 does not limit:

- (a) the indemnification obligations in Section 8;
- (b) liability for breach of Section 7 (data) or Section 10
  (confidentiality);
- (c) liability for gross negligence, willful misconduct, or
  fraud;
- (d) any non-waivable statutory liability.

## 12. Governing law and disputes

12.1 This Agreement is governed by the laws of Minnesota.

12.2 Any dispute arising out of or related to this Agreement
will be resolved by binding arbitration administered by the
American Arbitration Association under its Commercial
Arbitration Rules, in Hennepin County, Minnesota. Judgment
on the award may be entered in any court of competent
jurisdiction.

12.3 Notwithstanding Section 12.2, either party may seek
injunctive relief in court for misuse of intellectual
property or breach of Section 7 or Section 10.

`[REVIEW WITH COUNSEL]` — arbitration vs. court litigation
for a B2B contract is a strategic choice. Some Vendors will
prefer or refuse arbitration; have a fallback.

## 13. Miscellaneous

13.1 **Independent contractors.** The parties are independent
contractors. Nothing in this Agreement creates a
partnership, joint venture, agency, or employment
relationship.

13.2 **Assignment.** Neither party may assign this Agreement
without the other's prior written consent, except in
connection with a merger, sale of substantially all assets,
or change of control.

13.3 **Notices.** Notices under this Agreement must be in
writing and sent to the addresses on the signature page,
delivered by overnight courier or by email with read
receipt requested.

13.4 **Entire agreement.** This Agreement, including all
appendices, constitutes the entire agreement between the
parties and supersedes any prior oral or written
understandings on the same subject.

13.5 **Severability.** If any provision is unenforceable,
the remainder remains in effect.

13.6 **Waiver.** Failure to enforce any provision is not a
waiver of that provision.

13.7 **Force majeure.** Neither party is liable for delay or
failure to perform due to circumstances beyond reasonable
control (natural disaster, act of war, regulatory action
not specific to that party, internet outage).

13.8 **Amendments.** This Agreement may be amended only by
a writing signed by both parties.

---

`[REVIEW WITH COUNSEL]` — overall:

- Signature page (entity name, address, signatory, title,
  date, witness/notary if required).
- Appendices: insurance certificate template, Metrc reporting
  authorization (POA-like document), settlement-report
  schema, refund-authority matrix, DPA if required.
- Whether to require the Vendor's owners to personally
  guarantee (PG) obligations under this Agreement (typical
  for early-stage SaaS where the operator wants recourse
  against a thin entity; complicated for cannabis where the
  PG-er's identity is already on the OCM license).
- Whether the Vendor's authorized signatory has to be the
  same as the license-holder of record per OCM.
- Anti-MFN, exclusivity, or market-restriction provisions
  (we are not requiring exclusivity in v1; Vendor may list
  with competitor platforms — confirm posture).
