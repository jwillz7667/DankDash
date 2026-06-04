# Terms of Service

**DRAFT — `[REVIEW WITH COUNSEL]` before publication.**

Effective date: [TO BE SET AT PUBLICATION]
Last updated: [TO BE SET AT PUBLICATION]

These Terms of Service (the **"Terms"**) govern your use of the
DankDash consumer iOS application and the
[www.dankdash.com](https://www.dankdash.com) website, including
all checkout, ordering, and account features (together, the
**"Service"**) provided by DankDash, Inc., a Delaware
corporation with its principal office in Minnesota (**"DankDash"**,
**"we"**, **"us"**, **"our"**).

By creating an account, completing the age verification, or
placing an order, you (the **"User"**) agree to these Terms.
**If you do not agree, do not use the Service.**

`[REVIEW WITH COUNSEL]` — confirm corporate entity name,
state of incorporation, and registered agent are current.

## 1. Eligibility

1.1 The Service is available only to natural persons who:

- (a) are at least 21 years of age;
- (b) reside in or are physically present in the State of
  Minnesota at the time of order placement;
- (c) are not on any state or federal sanctioned-persons list;
- (d) are placing the order for personal, non-commercial,
  non-resale use.

  1.2 You must complete the in-app age gate before browsing
  products. The age gate collects your date of birth and an
  acknowledgement that you meet the criteria above. False
  information at the age gate is a material breach of these
  Terms and grounds for immediate account termination.

  1.3 At the time of delivery, you must present a
  state-issued or federally-issued photo identification with a
  date of birth consistent with the age-gate response. The
  Driver will not complete delivery without this verification.
  Refusal of ID presentation results in order cancellation and
  no refund of the cannabis-product subtotal; see Section 7.4.

  1.4 You may not maintain more than one active account. We
  reserve the right to merge or terminate duplicate accounts.

`[REVIEW WITH COUNSEL]` — confirm 21 (MN adult-use cannabis
age) is the correct floor across all product types; medical
cannabis users may have a different posture under Minn. Stat.
§ 152.

## 2. The Service

2.1 DankDash is a **technology platform** that connects Users
with licensed cannabis retailers operating in Minnesota
("**Dispensary Partners**") and with independent contractor
delivery drivers ("**Drivers**"). DankDash does not itself
hold any cannabis license, does not itself sell cannabis
products, and does not itself deliver cannabis products. The
sale of any cannabis product is between the User and the
Dispensary Partner; the delivery of any cannabis product is
performed by an independent contractor Driver.

`[REVIEW WITH COUNSEL]` — this characterization is critical
to our license posture. Confirm DankDash is correctly framed
as a marketplace and not a licensed cannabis retailer.

2.2 The Service includes:

- (a) a directory of Dispensary Partners in your delivery zone;
- (b) menus and product information published by Dispensary
  Partners;
- (c) cart and checkout features that initiate an order with a
  Dispensary Partner;
- (d) live order tracking;
- (e) order history, receipts, and customer support.

  2.3 Per Apple App Store policy, the **checkout step itself**
  takes place on `checkout.dankdash.com` in a Safari browser
  hand-off, not inside the iOS app. The hand-off is automatic;
  your cart and account session are preserved across the
  transition.

## 3. Account

3.1 To use the Service, you must create an account with a
valid email address and phone number. You are responsible for
the accuracy of the information you provide and for
maintaining the confidentiality of your login credentials.

3.2 You will be required to verify your identity at first
order using a government-issued ID, processed by our identity
verification provider Veriff. See the Privacy Policy for how
ID verification data is handled.

3.3 You may delete your account at any time from the Settings
screen. Account deletion is governed by the procedure
described in our Privacy Policy and the operational runbook
at `docs/runbooks/account-deletion-request.md`. Some records
are retained as required by Minnesota cannabis regulations
(Minn. Rule 21-23, 7-year retention) and tax law.

## 4. Orders, Pricing, Compliance Limits

4.1 All orders are subject to a **compliance evaluation** that
verifies, at the time of checkout:

- (a) per-transaction adult-use limits under Minn. Stat. §
  342.27 (currently 2 ounces / 56.7 grams of flower, 8 grams
  of concentrate, 800 milligrams of THC in edible form per
  transaction);
- (b) sale-hour restrictions (8:00 AM to 2:00 AM local time;
  individual Dispensary Partners may set narrower hours);
- (c) THC-beverage container limits (≤10 mg THC per serving,
  ≤2 servings per container);
- (d) the delivery address is within the Dispensary Partner's
  authorized delivery zone (the Dispensary Partner's
  delivery polygon) and within Minnesota.

`[REVIEW WITH COUNSEL]` — these limits are current as of
[publication date]; OCM has rulemaking authority to amend
them. The platform reads these limits from the compliance
engine at runtime; this section should not be the canonical
source. Confirm the disclosure obligation language.

4.2 An order that fails the compliance evaluation cannot be
placed. The Service will display the reason for the failure
(e.g., "this cart exceeds the per-transaction limit for
edibles") so you can adjust before retrying.

4.3 Prices, taxes, and fees are set by the Dispensary Partner
and are displayed in the cart before checkout. Tax includes
Minnesota state sales tax and the cannabis-specific gross
receipts tax under Minn. Stat. § 295.81 (currently 10%).
Delivery fees are set by DankDash and may vary by distance
and demand.

4.4 You authorize the Dispensary Partner to charge the
payment method on file (linked via our payment processor
Aeropay) for the total displayed at checkout. ACH bank
transfer is the only supported payment method; we do not
accept credit or debit card payments. See Section 5.

4.5 Cannabis products **cannot be returned for a refund** once
delivered, except in the case of (a) wrong product delivered,
(b) tampered packaging, or (c) defective product (vape
hardware failure, etc.), in each case subject to the
Dispensary Partner's specific return policy. Contact
[support@dankdash.com](mailto:support@dankdash.com) within
24 hours of delivery to initiate a claim.

`[REVIEW WITH COUNSEL]` — return / refund posture varies by
Dispensary Partner; confirm the platform-level disclosure
language is consistent with the variation we permit
Dispensary Partners to set.

## 5. Payment

5.1 Payments are processed by **Aeropay** (or such other
ACH-rails processor we may designate). When you link a bank
account to your DankDash account, you are authorizing Aeropay
to debit that account for orders you place.

5.2 The Dispensary Partner is the merchant of record for the
cannabis-product portion of your order. DankDash is the
merchant of record for the delivery fee and any DankDash
platform fee.

5.3 Cannabis cannot lawfully be charged to a credit or debit
card under the underwriting policies of the major card
networks. The Service does not present a credit/debit card
option; this is an industry-wide constraint, not a DankDash
limitation.

5.4 ACH debits typically settle within 1–3 business days.
A debit that fails (insufficient funds, closed account)
results in your order being marked unpaid; we may retry
collection up to two times. Unpaid amounts may be assigned
to a collections agency.

## 6. Delivery

6.1 Deliveries are performed by an independent contractor
Driver, retained through DankDash's driver onboarding process
and operating under the Driver Agreement (separate document).

6.2 The Driver will verify your identification at the point
of delivery. Refusal to present ID, or ID that does not match
the account-of-record, results in order cancellation and a
return-to-store. No refund is issued for cannabis products on
a refused-ID cancellation; the delivery fee is also
forfeited.

6.3 The Service displays a live order-tracking screen during
delivery. Estimated arrival times are best-effort and not
contractual.

6.4 You must be present at the registered delivery address to
receive the order. Deliveries cannot be left unattended.

6.5 Tipping the Driver is optional. Tips, if any, are routed
to the Driver in full.

## 7. Cancellation and Refunds

7.1 You may cancel an order at no charge **before** the
Dispensary Partner accepts it (this is typically within 5–10
minutes of placement). The cancel button is visible in the
order-tracking screen.

7.2 Once the Dispensary Partner accepts the order, the
Dispensary Partner has the option to refuse cancellation; if
they refuse, the order proceeds. Most Dispensary Partners
honor cancellations made within 15 minutes of placement.

7.3 Once a Driver has picked up the order, cancellation is no
longer available. The order completes at the registered
delivery address.

7.4 If you refuse delivery (refusal to present ID,
unavailability at the address, choice to refuse the delivered
product on receipt), the Dispensary Partner retains the
cannabis-product subtotal and DankDash retains the delivery
fee. The Driver returns the order to the Dispensary Partner.

## 8. Acceptable Use

8.1 You will not:

- (a) attempt to circumvent the age gate or ID verification;
- (b) create an account on behalf of someone else;
- (c) resell, redistribute, or transport cannabis products to
  any person under 21 or out of Minnesota;
- (d) operate any motor vehicle while under the influence of
  any cannabis product purchased through the Service;
- (e) abuse, harass, or threaten any Driver or any DankDash
  employee or contractor;
- (f) reverse engineer, decompile, or attempt to extract
  source code from the Service;
- (g) use the Service for any unlawful purpose, including in
  violation of federal cannabis law (we acknowledge cannabis
  is federally controlled; you accept the federal-state
  conflict as a known feature of state-legal cannabis).

  8.2 Violation of Section 8.1 is grounds for immediate account
  termination, forfeiture of any pending order, and where
  applicable, reporting to law enforcement or to OCM.

## 9. Intellectual Property

9.1 The Service, including the DankDash name, logo, app
design, software, and content (other than User-generated
content and Dispensary Partner content), is owned by DankDash
and is licensed to you under a limited, revocable,
non-exclusive, non-transferable license for personal,
non-commercial use.

9.2 Dispensary Partner content (product names, descriptions,
images, prices, COA records) is owned by the Dispensary
Partner or its suppliers. DankDash displays it under license.

9.3 You retain ownership of any User-generated content you
post (reviews, dispensary ratings) and grant DankDash a
worldwide, royalty-free, non-exclusive license to display
that content on the Service.

## 10. Privacy

Our [Privacy Policy](./privacy-policy.md) describes how we
collect, use, and share your personal information. By using
the Service, you consent to the practices described there.

## 11. Disclaimers

11.1 THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE,"
WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR
UNINTERRUPTED ACCESS, EXCEPT TO THE EXTENT SUCH WARRANTIES
CANNOT BE DISCLAIMED UNDER MINNESOTA LAW.

11.2 DANKDASH MAKES NO REPRESENTATION OR WARRANTY AS TO THE
SAFETY, EFFICACY, OR HEALTH IMPACT OF ANY CANNABIS PRODUCT.
ALL PRODUCT INFORMATION IS PROVIDED BY THE DISPENSARY
PARTNER OR ITS SUPPLIERS. CONSULT A LICENSED HEALTHCARE
PROVIDER BEFORE USING CANNABIS, ESPECIALLY IF YOU ARE
PREGNANT, NURSING, OR HAVE A KNOWN MEDICAL CONDITION.

11.3 CANNABIS PRODUCTS ARE NOT FOR USE BY PERSONS UNDER 21.
KEEP OUT OF REACH OF CHILDREN AND PETS. DO NOT OPERATE
MACHINERY OR DRIVE WHILE UNDER THE INFLUENCE.

`[REVIEW WITH COUNSEL]` — disclaimer language and required
warnings vary by product type under Minn. Rule 21-23.
Confirm full compliance.

## 12. Limitation of Liability

12.1 TO THE FULLEST EXTENT PERMITTED BY MINNESOTA LAW, IN NO
EVENT WILL DANKDASH BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
PROFITS, REVENUE, DATA, OR GOODWILL, ARISING OUT OF OR
RELATED TO YOUR USE OF THE SERVICE.

12.2 IN NO EVENT WILL DANKDASH'S TOTAL LIABILITY TO YOU FOR
ALL CLAIMS RELATED TO THE SERVICE EXCEED THE GREATER OF
(a) THE TOTAL FEES YOU PAID TO DANKDASH IN THE TWELVE MONTHS
PRECEDING THE CLAIM, OR (b) ONE HUNDRED U.S. DOLLARS ($100).

`[REVIEW WITH COUNSEL]` — limitation-of-liability caps are
subject to MN consumer-protection statutes that may render
them unenforceable in some contexts. Confirm the cap is
defensible.

## 13. Indemnification

You agree to indemnify and hold harmless DankDash, its
officers, directors, employees, contractors, and Dispensary
Partners from any claim, damage, liability, cost, or expense
(including reasonable attorneys' fees) arising out of (a)
your breach of these Terms, (b) your violation of any law,
(c) your unauthorized use of the Service, or (d) your
distribution of cannabis products to any person under 21 or
outside Minnesota.

## 14. Dispute Resolution

14.1 These Terms are governed by the laws of the State of
Minnesota, without regard to conflict of laws principles.

14.2 Any dispute arising out of or related to these Terms or
the Service will be resolved by **binding arbitration**
administered by the American Arbitration Association under
its Consumer Arbitration Rules, in Hennepin County,
Minnesota. The arbitrator's award is final and binding.

14.3 **Class action waiver.** You agree that any arbitration
or proceeding will be conducted only on an individual basis,
not as a class action, consolidated proceeding, or
representative action.

`[REVIEW WITH COUNSEL]` — arbitration + class-action-waiver
posture must be defended against MN consumer-protection
constraints and against FAA preemption analysis. Confirm the
formulation is enforceable and the carve-outs (small-claims,
injunctive relief for IP claims) are included.

14.4 Notwithstanding Section 14.2, either party may bring an
individual action in small-claims court, or seek injunctive
relief in court for misuse of intellectual property.

## 15. Changes to the Terms

15.1 We may modify these Terms at any time. The modified
Terms take effect on the date posted at the top of this
document. We will notify you of material changes by email
(if you have an account) and in-app on next launch.

15.2 If you do not agree to the modified Terms, your sole
remedy is to stop using the Service and delete your account.
Continued use after modification constitutes acceptance.

## 16. Contact

DankDash, Inc.
[REGISTERED ADDRESS] `[FACT-CHECK]`
[support@dankdash.com](mailto:support@dankdash.com)
[legal@dankdash.com](mailto:legal@dankdash.com)
[privacy@dankdash.com](mailto:privacy@dankdash.com)

---

`[REVIEW WITH COUNSEL]` — overall review of:

- Severability clause (should be added).
- Force majeure clause (should be added).
- Notice procedure for legal process (DMCA, subpoenas).
- Anti-assignment clause (User cannot assign their account).
- Section-headings-not-controlling boilerplate.
- E-sign Act compliance for electronic acceptance.
- Apple-required clauses for App Store distribution (third-party
  beneficiary disclaimer; Apple as third-party beneficiary).
