/**
 * Promo eligibility + discount, as one pure decision.
 *
 * The API calls this INSIDE the checkout transaction (server-authoritative,
 * mirroring how compliance is re-run at checkout) after locking the promo row
 * and counting redemptions under that lock, so the caps it enforces here are
 * race-free. The cart apply-endpoint calls it for the live preview, and iOS
 * mirrors it for an offline preview — all three share this exact logic.
 *
 * Check order is intentional and stable (the first failing gate is the one
 * surfaced to the user): existence/activity → time window → scope → spend
 * threshold → global cap → per-user cap. A code the user cannot use for a
 * structural reason (inactive/expired/wrong store) is reported before a
 * reason they could fix by changing the cart (min subtotal) or that depends
 * on counts (caps).
 */
import { computeDiscountCents } from './compute.js';
import type { PromoDefinition, PromoEvaluation, PromoEvaluationContext } from './types.js';

export function evaluatePromo(
  promo: PromoDefinition,
  ctx: PromoEvaluationContext,
): PromoEvaluation {
  if (!promo.active) {
    return { ok: false, reason: 'inactive' };
  }
  if (ctx.now.getTime() < promo.startsAt.getTime()) {
    return { ok: false, reason: 'not_started' };
  }
  if (promo.endsAt !== null && ctx.now.getTime() >= promo.endsAt.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (promo.scope === 'dispensary' && promo.dispensaryId !== ctx.cartDispensaryId) {
    return { ok: false, reason: 'wrong_dispensary' };
  }
  if (ctx.subtotalCents < promo.minSubtotalCents) {
    return { ok: false, reason: 'min_subtotal' };
  }
  if (promo.maxRedemptions !== null && ctx.globalRedemptionCount >= promo.maxRedemptions) {
    return { ok: false, reason: 'exhausted' };
  }
  if (ctx.userRedemptionCount >= promo.maxRedemptionsPerUser) {
    return { ok: false, reason: 'already_used' };
  }

  const discountCents = computeDiscountCents(promo, ctx.subtotalCents, ctx.deliveryFeeCents);
  return { ok: true, promoId: promo.id, discountCents, fundedBy: promo.scope };
}
