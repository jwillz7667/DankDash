import { describe, expect, it } from 'vitest';
import { type Compliance } from './api-schemas.js';
import {
  complianceBars,
  failedRuleLabel,
  formatCents,
  isValidTipCents,
  MAX_DRIVER_TIP_CENTS,
  MIN_DRIVER_TIP_CENTS,
  orderCompleteDeepLink,
  tipDollarsToCents,
} from './format.js';

describe('formatCents', () => {
  it('formats whole and fractional dollars', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(100)).toBe('$1.00');
  });

  it('groups thousands and handles negatives', () => {
    expect(formatCents(1234567)).toBe('$12,345.67');
    expect(formatCents(-250)).toBe('-$2.50');
  });
});

describe('tipDollarsToCents', () => {
  it('rounds dollars to cents', () => {
    expect(tipDollarsToCents(8)).toBe(800);
    expect(tipDollarsToCents(8.005)).toBe(801);
  });

  it('clamps to the statutory floor and the cap', () => {
    expect(tipDollarsToCents(0)).toBe(MIN_DRIVER_TIP_CENTS);
    expect(tipDollarsToCents(1)).toBe(MIN_DRIVER_TIP_CENTS);
    expect(tipDollarsToCents(9999)).toBe(MAX_DRIVER_TIP_CENTS);
  });

  it('falls back to the floor for non-finite input', () => {
    expect(tipDollarsToCents(Number.NaN)).toBe(MIN_DRIVER_TIP_CENTS);
  });
});

describe('isValidTipCents', () => {
  it('accepts only integers within range', () => {
    expect(isValidTipCents(200)).toBe(true);
    expect(isValidTipCents(50_000)).toBe(true);
    expect(isValidTipCents(199)).toBe(false);
    expect(isValidTipCents(50_001)).toBe(false);
    expect(isValidTipCents(300.5)).toBe(false);
  });
});

function compliance(overrides: Partial<Compliance> = {}): Compliance {
  return {
    passed: true,
    rules: [],
    cartTotals: { flowerGrams: 0, concentrateGrams: 0, edibleThcMg: 0 },
    limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
    evaluatedAt: '2026-06-28T18:00:00.000Z',
    evaluationVersion: 'v1',
    ...overrides,
  };
}

describe('complianceBars', () => {
  it('returns the three statutory dimensions with clamped percentages', () => {
    const bars = complianceBars(
      compliance({
        cartTotals: { flowerGrams: 28.35, concentrateGrams: 8, edibleThcMg: 1000 },
      }),
    );
    expect(bars.map((b) => b.label)).toEqual(['Flower', 'Concentrate', 'Edible THC']);
    expect(bars[0]?.percent).toBe(50);
    expect(bars[0]?.tone).toBe('ok');
    expect(bars[1]?.percent).toBe(100);
    expect(bars[1]?.tone).toBe('over');
    // Over the cap clamps to 100 and reads as 'over'.
    expect(bars[2]?.percent).toBe(100);
    expect(bars[2]?.tone).toBe('over');
  });

  it('marks the 70–99% band as warn', () => {
    const bars = complianceBars(
      compliance({ cartTotals: { flowerGrams: 45, concentrateGrams: 0, edibleThcMg: 0 } }),
    );
    expect(bars[0]?.tone).toBe('warn');
  });

  it('guards against a zero/invalid max', () => {
    const bars = complianceBars(
      compliance({
        limits: { flowerGramsMax: 0.0001, concentrateGramsMax: 8, edibleThcMgMax: 800 },
      }),
    );
    expect(bars[0]?.percent).toBeGreaterThanOrEqual(0);
    expect(bars[0]?.percent).toBeLessThanOrEqual(100);
  });
});

describe('failedRuleLabel', () => {
  it('maps known rule ids to labels and passes through unknowns', () => {
    expect(failedRuleLabel('per_transaction_limit')).toBe('Purchase limit');
    expect(failedRuleLabel('delivery_geofence')).toBe('Delivery area');
    expect(failedRuleLabel('mystery_rule')).toBe('mystery_rule');
  });
});

describe('orderCompleteDeepLink', () => {
  it('builds the iOS return deep link with an encoded id', () => {
    expect(orderCompleteDeepLink('abc-123')).toBe('dankdash://order/complete?orderId=abc-123');
    expect(orderCompleteDeepLink('a/b?c')).toBe('dankdash://order/complete?orderId=a%2Fb%3Fc');
  });
});
