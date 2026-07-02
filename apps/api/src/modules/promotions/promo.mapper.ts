/**
 * Shared adapters between the `promo_codes` DB row, the pure
 * `@dankdash/promotions` domain shape, and the typed `PromoError` wire family.
 * Used by the cart apply endpoint, the checkout re-validation, and (for the
 * error mapping) anywhere a rejection reason must become an HTTP error.
 */
import { PromoError, type ErrorDetails } from '@dankdash/types';
import type { PromoResponse } from './dto/index.js';
import type { PromoCode } from '@dankdash/db';
import type { PromoDefinition, PromoRejectionReason } from '@dankdash/promotions';

/** Project a persisted promo row onto the pure evaluator's input shape. */
export function promoRowToDefinition(row: PromoCode): PromoDefinition {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    scope: row.scope,
    dispensaryId: row.dispensaryId,
    minSubtotalCents: row.minSubtotalCents,
    maxDiscountCents: row.maxDiscountCents,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    maxRedemptions: row.maxRedemptions,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    active: row.active,
  };
}

const REASON_TO_CODE = {
  inactive: 'PROMO_INACTIVE',
  not_started: 'PROMO_NOT_STARTED',
  expired: 'PROMO_EXPIRED',
  wrong_dispensary: 'PROMO_WRONG_DISPENSARY',
  min_subtotal: 'PROMO_MIN_SUBTOTAL',
  exhausted: 'PROMO_EXHAUSTED',
  already_used: 'PROMO_ALREADY_USED',
} as const satisfies Record<PromoRejectionReason, string>;

const REASON_TO_MESSAGE = {
  inactive: 'This promo code is not active',
  not_started: 'This promo code is not active yet',
  expired: 'This promo code has expired',
  wrong_dispensary: 'This promo code is not valid for this dispensary',
  min_subtotal: 'Your cart does not meet the minimum for this promo code',
  exhausted: 'This promo code has reached its redemption limit',
  already_used: 'You have already used this promo code',
} as const satisfies Record<PromoRejectionReason, string>;

/** Project a promo row + its live redemption count onto the wire shape. */
export function projectPromo(row: PromoCode, redemptionCount: number): PromoResponse {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    scope: row.scope,
    dispensaryId: row.dispensaryId,
    minSubtotalCents: row.minSubtotalCents,
    maxDiscountCents: row.maxDiscountCents,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    maxRedemptions: row.maxRedemptions,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    active: row.active,
    redemptionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a pure rejection reason to the typed 422 `PromoError` for the wire. */
export function promoErrorForReason(
  reason: PromoRejectionReason,
  details: ErrorDetails = {},
): PromoError {
  return new PromoError(REASON_TO_CODE[reason], REASON_TO_MESSAGE[reason], details);
}
