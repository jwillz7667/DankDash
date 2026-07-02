import { describe, expect, it } from 'vitest';
import { evaluatePromo } from '../src/evaluate.js';
import type { PromoDefinition, PromoEvaluationContext } from '../src/types.js';

const NOW = new Date('2026-07-02T18:00:00Z');

function promo(overrides: Partial<PromoDefinition>): PromoDefinition {
  return {
    id: 'promo-1',
    code: 'SAVE10',
    type: 'percent',
    value: 10,
    scope: 'platform',
    dispensaryId: null,
    minSubtotalCents: 0,
    maxDiscountCents: null,
    startsAt: new Date('2026-07-01T00:00:00Z'),
    endsAt: new Date('2026-08-01T00:00:00Z'),
    maxRedemptions: null,
    maxRedemptionsPerUser: 1,
    active: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<PromoEvaluationContext>): PromoEvaluationContext {
  return {
    subtotalCents: 5000,
    deliveryFeeCents: 0,
    cartDispensaryId: 'disp-1',
    now: NOW,
    globalRedemptionCount: 0,
    userRedemptionCount: 0,
    ...overrides,
  };
}

describe('evaluatePromo — rejections', () => {
  it('rejects an inactive promo', () => {
    expect(evaluatePromo(promo({ active: false }), ctx({}))).toEqual({
      ok: false,
      reason: 'inactive',
    });
  });

  it('rejects a promo that has not started', () => {
    expect(evaluatePromo(promo({ startsAt: new Date('2026-07-03T00:00:00Z') }), ctx({}))).toEqual({
      ok: false,
      reason: 'not_started',
    });
  });

  it('rejects a promo whose end is at or before now', () => {
    expect(evaluatePromo(promo({ endsAt: NOW }), ctx({}))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a dispensary-scoped promo for a different dispensary', () => {
    expect(
      evaluatePromo(
        promo({ scope: 'dispensary', dispensaryId: 'disp-other' }),
        ctx({ cartDispensaryId: 'disp-1' }),
      ),
    ).toEqual({ ok: false, reason: 'wrong_dispensary' });
  });

  it('rejects a cart below the minimum subtotal', () => {
    expect(evaluatePromo(promo({ minSubtotalCents: 6000 }), ctx({ subtotalCents: 5000 }))).toEqual({
      ok: false,
      reason: 'min_subtotal',
    });
  });

  it('rejects a globally exhausted promo', () => {
    expect(
      evaluatePromo(promo({ maxRedemptions: 100 }), ctx({ globalRedemptionCount: 100 })),
    ).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('rejects a promo the user already used up to their cap', () => {
    expect(
      evaluatePromo(promo({ maxRedemptionsPerUser: 1 }), ctx({ userRedemptionCount: 1 })),
    ).toEqual({ ok: false, reason: 'already_used' });
  });
});

describe('evaluatePromo — acceptance', () => {
  it('accepts a valid platform promo and reports platform funding', () => {
    expect(evaluatePromo(promo({ value: 10 }), ctx({ subtotalCents: 5000 }))).toEqual({
      ok: true,
      promoId: 'promo-1',
      discountCents: 500,
      fundedBy: 'platform',
    });
  });

  it('accepts a valid dispensary promo for its own dispensary and reports dispensary funding', () => {
    expect(
      evaluatePromo(
        promo({ scope: 'dispensary', dispensaryId: 'disp-1', value: 20 }),
        ctx({ cartDispensaryId: 'disp-1', subtotalCents: 5000 }),
      ),
    ).toEqual({ ok: true, promoId: 'promo-1', discountCents: 1000, fundedBy: 'dispensary' });
  });

  it('treats a null endsAt as never expiring', () => {
    const result = evaluatePromo(promo({ endsAt: null }), ctx({}));
    expect(result.ok).toBe(true);
  });

  it('treats a null maxRedemptions as unlimited', () => {
    const result = evaluatePromo(
      promo({ maxRedemptions: null }),
      ctx({ globalRedemptionCount: 10_000 }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts exactly at the start boundary', () => {
    const result = evaluatePromo(promo({ startsAt: NOW }), ctx({}));
    expect(result.ok).toBe(true);
  });
});
