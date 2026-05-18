/**
 * Pricing-totals unit tests.
 *
 * The cases that earn their keep here:
 *
 *   - One-line cannabis sale at a round number → tax numbers match the
 *     hand calculation. If the cannabis-tax-in-sales-base rule ever
 *     gets dropped, the sales-tax number changes and this test
 *     catches it.
 *   - Multi-line mixed cart with one taxable + one accessory line —
 *     verifies the per-line accessory exemption and that line + header
 *     reconcile (the DB CHECK enforces the same equality at insert time).
 *   - Banker's rounding on a half-cent tie — `Math.round` would round
 *     up, banker's rounds to even. This is the specific test that
 *     guards against someone "fixing" the rounding by switching to
 *     `Math.round`.
 *   - Local sales tax add-on lifts the sales tax proportionally.
 *   - Discount = subtotal is allowed (free order with delivery fee).
 *   - Empty cart, NaN inputs, fractional cents, negative tip, etc. all
 *     throw RangeError — these are programmer errors at the boundary
 *     between the cart service and pricing, never user input.
 */
import { describe, expect, it } from 'vitest';
import { computeOrderTotals, computePlatformFeeCents } from '../src/index.js';
import type { PricingLine, PricingOptions } from '../src/index.js';

const noFees: PricingOptions = {
  deliveryFeeCents: 0,
  driverTipCents: 0,
  discountCents: 0,
};

describe('computeOrderTotals — happy path', () => {
  it('prices a single flower line at $45.00 with no local tax', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 4500, quantity: 1, productType: 'flower' }];

    const result = computeOrderTotals(lines, noFees);

    expect(result.lines).toEqual([
      // 4500 * 0.10 = 450 cannabis tax
      // (4500 + 450) * 0.06875 = 4950 * 0.06875 = 340.3125 → banker's → 340
      { lineSubtotalCents: 4500, cannabisTaxCents: 450, salesTaxCents: 340 },
    ]);
    expect(result.totals).toEqual({
      subtotalCents: 4500,
      cannabisTaxCents: 450,
      salesTaxCents: 340,
      deliveryFeeCents: 0,
      driverTipCents: 0,
      discountCents: 0,
      // 4500 + 450 + 340 = 5290
      totalCents: 5290,
    });
  });

  it('prices a multi-unit preroll line: subtotal scales with quantity', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 1200, quantity: 3, productType: 'preroll' }];

    const result = computeOrderTotals(lines, noFees);

    // 1200 * 3 = 3600
    // cannabis: 3600 * 0.10 = 360
    // sales: (3600 + 360) * 0.06875 = 3960 * 0.06875 = 272.25 → banker's → 272
    expect(result.lines).toEqual([
      { lineSubtotalCents: 3600, cannabisTaxCents: 360, salesTaxCents: 272 },
    ]);
    expect(result.totals.totalCents).toBe(3600 + 360 + 272);
  });

  it('exempts accessory lines from cannabis tax but applies sales tax', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 1500, quantity: 1, productType: 'accessory' }];

    const result = computeOrderTotals(lines, noFees);

    expect(result.lines[0]?.cannabisTaxCents).toBe(0);
    // Sales tax base = subtotal (no excise added): 1500 * 0.06875 = 103.125 → banker's → 103
    expect(result.lines[0]?.salesTaxCents).toBe(103);
    expect(result.totals.cannabisTaxCents).toBe(0);
    expect(result.totals.totalCents).toBe(1500 + 103);
  });

  it('reconciles header totals as the sum of line totals on a mixed cart', () => {
    const lines: PricingLine[] = [
      { unitPriceCents: 4500, quantity: 1, productType: 'flower' },
      { unitPriceCents: 1500, quantity: 1, productType: 'accessory' },
      { unitPriceCents: 2500, quantity: 2, productType: 'edible' },
    ];

    const result = computeOrderTotals(lines, noFees);

    const sumSubtotal = result.lines.reduce((acc, l) => acc + l.lineSubtotalCents, 0);
    const sumCannabis = result.lines.reduce((acc, l) => acc + l.cannabisTaxCents, 0);
    const sumSales = result.lines.reduce((acc, l) => acc + l.salesTaxCents, 0);

    expect(result.totals.subtotalCents).toBe(sumSubtotal);
    expect(result.totals.cannabisTaxCents).toBe(sumCannabis);
    expect(result.totals.salesTaxCents).toBe(sumSales);
    expect(result.totals.totalCents).toBe(sumSubtotal + sumCannabis + sumSales);
  });

  it('passes through delivery fee, tip, and discount into the total', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 4500, quantity: 1, productType: 'flower' }];

    const result = computeOrderTotals(lines, {
      deliveryFeeCents: 500,
      driverTipCents: 750,
      discountCents: 100,
    });

    expect(result.totals.deliveryFeeCents).toBe(500);
    expect(result.totals.driverTipCents).toBe(750);
    expect(result.totals.discountCents).toBe(100);
    // 4500 + 450 + 340 + 500 + 750 - 100 = 6440
    expect(result.totals.totalCents).toBe(6440);
  });

  it('does NOT apply cannabis or sales tax to delivery fee or tip', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 1000, quantity: 1, productType: 'accessory' }];

    const result = computeOrderTotals(lines, {
      deliveryFeeCents: 1000,
      driverTipCents: 1000,
      discountCents: 0,
    });

    // Only the accessory line drives the sales-tax line: 1000 * 0.06875 = 68.75 → 69
    // (banker's only differs from standard rounding at exact .5 ties)
    expect(result.totals.salesTaxCents).toBe(69);
    expect(result.totals.cannabisTaxCents).toBe(0);
    expect(result.totals.totalCents).toBe(1000 + 0 + 69 + 1000 + 1000 - 0);
  });

  it('allows a discount that exactly equals the subtotal (free product, delivery still charged)', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 2000, quantity: 1, productType: 'flower' }];

    const result = computeOrderTotals(lines, {
      deliveryFeeCents: 500,
      driverTipCents: 0,
      discountCents: 2000,
    });

    // Taxes still apply on the gross sale; the discount is a header-level adjustment.
    expect(result.totals.subtotalCents).toBe(2000);
    expect(result.totals.discountCents).toBe(2000);
    // cannabis: 200; sales: (2000+200)*0.06875 = 151.25 → 151
    // total: 2000 + 200 + 151 + 500 + 0 - 2000 = 851
    expect(result.totals.totalCents).toBe(851);
  });
});

describe("computeOrderTotals — banker's rounding", () => {
  it('rounds .5 to the nearest even integer (1.5 → 2, 2.5 → 2)', () => {
    // unit_price = 20 → cannabis = 2 → base = 22; sales rate = 0.06818... — pick a rate that yields exactly .5
    // Easier: construct local-tax cases that produce known half-cent ties.
    // 20 cents * 7.5% = 1.5 cents → banker's → 2 (round to even, 2 is even)
    const oneFive = computeOrderTotals(
      [{ unitPriceCents: 20, quantity: 1, productType: 'accessory' }],
      { deliveryFeeCents: 0, driverTipCents: 0, discountCents: 0, localSalesTaxRate: 0.00625 },
    );
    // 20 * (0.06875 + 0.00625) = 20 * 0.075 = 1.5 → banker → 2
    expect(oneFive.lines[0]?.salesTaxCents).toBe(2);

    // 100 cents * 12.5% = 12.5 → banker → 12 (12 is even, 13 is odd → 12)
    const twelveFive = computeOrderTotals(
      [{ unitPriceCents: 100, quantity: 1, productType: 'accessory' }],
      { deliveryFeeCents: 0, driverTipCents: 0, discountCents: 0, localSalesTaxRate: 0.05625 },
    );
    expect(twelveFive.lines[0]?.salesTaxCents).toBe(12);
  });

  it('rounds non-tie fractions normally (.49 down, .51 up)', () => {
    // accessory of 1 cent: 1 * 0.06875 = 0.06875 → 0
    const tiny = computeOrderTotals(
      [{ unitPriceCents: 1, quantity: 1, productType: 'accessory' }],
      noFees,
    );
    expect(tiny.lines[0]?.salesTaxCents).toBe(0);

    // accessory of 10 cents: 10 * 0.06875 = 0.6875 → 1
    const small = computeOrderTotals(
      [{ unitPriceCents: 10, quantity: 1, productType: 'accessory' }],
      noFees,
    );
    expect(small.lines[0]?.salesTaxCents).toBe(1);
  });
});

describe('computeOrderTotals — local sales tax', () => {
  it('adds the local rate on top of the state rate', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 10_000, quantity: 1, productType: 'flower' }];

    const noLocal = computeOrderTotals(lines, noFees);
    const withMinneapolis = computeOrderTotals(lines, { ...noFees, localSalesTaxRate: 0.005 });

    // Minneapolis adds 0.5% → sales tax should be measurably higher.
    expect(withMinneapolis.totals.salesTaxCents).toBeGreaterThan(noLocal.totals.salesTaxCents);
    // sales base = 10000 + 1000 = 11000; 11000 * 0.07375 = 811.25 → banker's → 811
    expect(withMinneapolis.totals.salesTaxCents).toBe(811);
  });

  it('treats undefined and 0 local rates identically', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 10_000, quantity: 1, productType: 'flower' }];

    const undef = computeOrderTotals(lines, noFees);
    const zero = computeOrderTotals(lines, { ...noFees, localSalesTaxRate: 0 });

    expect(undef.totals).toEqual(zero.totals);
  });
});

describe('computeOrderTotals — input validation', () => {
  it('throws on an empty cart', () => {
    expect(() => computeOrderTotals([], noFees)).toThrow(RangeError);
  });

  it.each<[string, PricingLine]>([
    ['negative unit price', { unitPriceCents: -1, quantity: 1, productType: 'flower' }],
    ['fractional unit price', { unitPriceCents: 1500.5, quantity: 1, productType: 'flower' }],
    ['NaN unit price', { unitPriceCents: Number.NaN, quantity: 1, productType: 'flower' }],
    [
      'Infinity unit price',
      { unitPriceCents: Number.POSITIVE_INFINITY, quantity: 1, productType: 'flower' },
    ],
    ['zero quantity', { unitPriceCents: 1500, quantity: 0, productType: 'flower' }],
    ['negative quantity', { unitPriceCents: 1500, quantity: -2, productType: 'flower' }],
    ['fractional quantity', { unitPriceCents: 1500, quantity: 1.5, productType: 'flower' }],
    ['NaN quantity', { unitPriceCents: 1500, quantity: Number.NaN, productType: 'flower' }],
  ])('rejects bad line input: %s', (_label, line) => {
    expect(() => computeOrderTotals([line], noFees)).toThrow(RangeError);
  });

  it.each<[string, PricingOptions]>([
    ['negative delivery fee', { deliveryFeeCents: -1, driverTipCents: 0, discountCents: 0 }],
    ['fractional delivery fee', { deliveryFeeCents: 100.5, driverTipCents: 0, discountCents: 0 }],
    ['negative tip', { deliveryFeeCents: 0, driverTipCents: -1, discountCents: 0 }],
    ['NaN tip', { deliveryFeeCents: 0, driverTipCents: Number.NaN, discountCents: 0 }],
    ['negative discount', { deliveryFeeCents: 0, driverTipCents: 0, discountCents: -1 }],
    [
      'NaN local rate',
      { deliveryFeeCents: 0, driverTipCents: 0, discountCents: 0, localSalesTaxRate: Number.NaN },
    ],
    [
      'negative local rate',
      { deliveryFeeCents: 0, driverTipCents: 0, discountCents: 0, localSalesTaxRate: -0.01 },
    ],
    [
      'Infinity local rate',
      {
        deliveryFeeCents: 0,
        driverTipCents: 0,
        discountCents: 0,
        localSalesTaxRate: Number.POSITIVE_INFINITY,
      },
    ],
  ])('rejects bad option input: %s', (_label, opts) => {
    const lines: PricingLine[] = [{ unitPriceCents: 1000, quantity: 1, productType: 'flower' }];
    expect(() => computeOrderTotals(lines, opts)).toThrow(RangeError);
  });

  it('rejects a discount that exceeds the subtotal', () => {
    const lines: PricingLine[] = [{ unitPriceCents: 1000, quantity: 1, productType: 'flower' }];

    expect(() =>
      computeOrderTotals(lines, { deliveryFeeCents: 0, driverTipCents: 0, discountCents: 1001 }),
    ).toThrow(RangeError);
  });
});

describe('computeOrderTotals — integer contract', () => {
  it('returns only integer cent values for every field', () => {
    const lines: PricingLine[] = [
      { unitPriceCents: 4500, quantity: 1, productType: 'flower' },
      { unitPriceCents: 1500, quantity: 1, productType: 'accessory' },
      { unitPriceCents: 2333, quantity: 3, productType: 'beverage' },
    ];

    const result = computeOrderTotals(lines, {
      deliveryFeeCents: 599,
      driverTipCents: 250,
      discountCents: 100,
      localSalesTaxRate: 0.005,
    });

    for (const line of result.lines) {
      expect(Number.isInteger(line.lineSubtotalCents)).toBe(true);
      expect(Number.isInteger(line.cannabisTaxCents)).toBe(true);
      expect(Number.isInteger(line.salesTaxCents)).toBe(true);
    }
    expect(Number.isInteger(result.totals.subtotalCents)).toBe(true);
    expect(Number.isInteger(result.totals.cannabisTaxCents)).toBe(true);
    expect(Number.isInteger(result.totals.salesTaxCents)).toBe(true);
    expect(Number.isInteger(result.totals.totalCents)).toBe(true);
  });
});

describe('computePlatformFeeCents', () => {
  it('takes 15% of a round subtotal', () => {
    // 10000 * 0.15 = 1500 exactly
    expect(computePlatformFeeCents(10_000)).toBe(1500);
  });

  it('is exactly zero on a zero subtotal', () => {
    expect(computePlatformFeeCents(0)).toBe(0);
  });

  it('banker-rounds half-cent ties to even (matches the tax rounding rule)', () => {
    // 5 * 0.15 = 0.75 → banker's rounds to 0 (toward even); but 0.75 is
    // not a half-tie. Use 10 → 1.5 cents → banker's → 2 (nearest even).
    expect(computePlatformFeeCents(10)).toBe(2);
    // 30 → 4.5 → banker's → 4 (nearest even). `Math.round` would give 5.
    expect(computePlatformFeeCents(30)).toBe(4);
  });

  it('rejects negative subtotals as programmer error', () => {
    expect(() => computePlatformFeeCents(-1)).toThrow(RangeError);
  });

  it('rejects fractional cents as programmer error', () => {
    expect(() => computePlatformFeeCents(100.5)).toThrow(RangeError);
  });

  it('rejects NaN as programmer error', () => {
    expect(() => computePlatformFeeCents(Number.NaN)).toThrow(RangeError);
  });

  it('scales linearly across realistic order sizes', () => {
    // 4_500 → 675; 12_345 → 1852 (banker's rounds 1851.75 → 1852).
    expect(computePlatformFeeCents(4_500)).toBe(675);
    expect(computePlatformFeeCents(12_345)).toBe(1852);
    // 99_999 → 14999.85 → 15000.
    expect(computePlatformFeeCents(99_999)).toBe(15_000);
  });
});
