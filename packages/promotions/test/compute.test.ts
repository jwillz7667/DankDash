import { describe, expect, it } from 'vitest';
import { computeDiscountCents } from '../src/compute.js';
import type { PromoDefinition } from '../src/types.js';

function promo(overrides: Partial<PromoDefinition>): PromoDefinition {
  return {
    id: 'p1',
    code: 'SAVE',
    type: 'percent',
    value: 10,
    scope: 'platform',
    dispensaryId: null,
    minSubtotalCents: 0,
    maxDiscountCents: null,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
    maxRedemptions: null,
    maxRedemptionsPerUser: 1,
    active: true,
    ...overrides,
  };
}

describe('computeDiscountCents — input guards', () => {
  it('rejects a negative subtotal', () => {
    expect(() => computeDiscountCents(promo({}), -1, 0)).toThrow(RangeError);
  });

  it('rejects a non-integer subtotal', () => {
    expect(() => computeDiscountCents(promo({}), 100.5, 0)).toThrow(RangeError);
  });

  it('rejects a non-finite subtotal', () => {
    expect(() => computeDiscountCents(promo({}), Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
  });

  it('rejects a negative delivery fee', () => {
    expect(() => computeDiscountCents(promo({ type: 'free_delivery', value: 0 }), 100, -1)).toThrow(
      RangeError,
    );
  });
});

describe('computeDiscountCents — percent', () => {
  it('takes a whole-percent cut of the subtotal', () => {
    expect(computeDiscountCents(promo({ value: 10 }), 5000, 0)).toBe(500);
  });

  it('banker-rounds a half-cent tie down to even (0)', () => {
    // 50% of 1 cent = 0.5 → round-half-to-even → 0.
    expect(computeDiscountCents(promo({ value: 50 }), 1, 0)).toBe(0);
  });

  it('banker-rounds a half-cent tie up to even (2)', () => {
    // 50% of 3 cents = 1.5 → round-half-to-even → 2.
    expect(computeDiscountCents(promo({ value: 50 }), 3, 0)).toBe(2);
  });

  it('applies maxDiscountCents when the percent exceeds it', () => {
    expect(computeDiscountCents(promo({ value: 50, maxDiscountCents: 1000 }), 5000, 0)).toBe(1000);
  });

  it('ignores maxDiscountCents when the percent is under it', () => {
    expect(computeDiscountCents(promo({ value: 10, maxDiscountCents: 1000 }), 5000, 0)).toBe(500);
  });

  it('clamps a 100% discount to the subtotal', () => {
    expect(computeDiscountCents(promo({ value: 100 }), 5000, 0)).toBe(5000);
  });

  it('rejects a percent value below the minimum', () => {
    expect(() => computeDiscountCents(promo({ value: 0 }), 5000, 0)).toThrow(RangeError);
  });

  it('rejects a percent value above the maximum', () => {
    expect(() => computeDiscountCents(promo({ value: 101 }), 5000, 0)).toThrow(RangeError);
  });

  it('rejects a non-integer percent value', () => {
    expect(() => computeDiscountCents(promo({ value: 12.5 }), 5000, 0)).toThrow(RangeError);
  });
});

describe('computeDiscountCents — fixed_amount', () => {
  it('returns the flat amount', () => {
    expect(computeDiscountCents(promo({ type: 'fixed_amount', value: 500 }), 5000, 0)).toBe(500);
  });

  it('clamps the flat amount to the subtotal', () => {
    expect(computeDiscountCents(promo({ type: 'fixed_amount', value: 9000 }), 5000, 0)).toBe(5000);
  });

  it('rejects a negative fixed amount', () => {
    expect(() => computeDiscountCents(promo({ type: 'fixed_amount', value: -1 }), 5000, 0)).toThrow(
      RangeError,
    );
  });
});

describe('computeDiscountCents — free_delivery', () => {
  it('waives the delivery fee', () => {
    expect(computeDiscountCents(promo({ type: 'free_delivery', value: 0 }), 5000, 700)).toBe(700);
  });

  it('is a no-op when there is no delivery fee', () => {
    expect(computeDiscountCents(promo({ type: 'free_delivery', value: 0 }), 5000, 0)).toBe(0);
  });

  it('clamps the waived fee to the subtotal', () => {
    expect(computeDiscountCents(promo({ type: 'free_delivery', value: 0 }), 300, 700)).toBe(300);
  });
});
