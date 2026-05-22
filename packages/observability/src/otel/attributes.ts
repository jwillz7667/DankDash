/**
 * DankDash-local semantic-convention attribute keys.
 *
 * OpenTelemetry's published conventions cover HTTP, RPC, DB, and
 * messaging — anything cannabis-specific (order id, dispensary id,
 * driver id, compliance rule code) needs a vendor-namespaced key.
 * The convention here is `dankdash.<resource>.<field>`.
 *
 * Use these constants instead of literal strings at every span /
 * counter / log enrichment call site. A typo in a literal silently
 * creates a new attribute that does not appear on dashboards; using
 * the constant fails at compile time if the export goes away.
 */
export const DANKDASH_ATTRS = {
  orderId: 'dankdash.order.id',
  orderStatus: 'dankdash.order.status',
  orderShortCode: 'dankdash.order.short_code',
  dispensaryId: 'dankdash.dispensary.id',
  dispensaryState: 'dankdash.dispensary.state',
  driverId: 'dankdash.driver.id',
  userId: 'dankdash.user.id',
  userRole: 'dankdash.user.role',
  requestId: 'dankdash.request.id',
  complianceRuleCode: 'dankdash.compliance.rule_code',
  complianceResult: 'dankdash.compliance.result',
  veriffSessionId: 'dankdash.veriff.session_id',
  veriffDecision: 'dankdash.veriff.decision',
  metrcPackageTag: 'dankdash.metrc.package_tag',
  paymentMethodType: 'dankdash.payment.method_type',
  payoutId: 'dankdash.payout.id',
  cartId: 'dankdash.cart.id',
} as const;

export type DankDashAttrKey = keyof typeof DANKDASH_ATTRS;
export type DankDashAttrName = (typeof DANKDASH_ATTRS)[DankDashAttrKey];
