/**
 * Cart-math unit tests.
 *
 * These cover the aggregation contract directly (the per-transaction-limit
 * rule tests it transitively, but the rule could in principle skip a
 * category mapping and not be caught). The cases that earn their keep:
 *
 *   - Every `ProductType` rolls into the documented cap category.
 *   - Decimal precision survives a multi-line sum that overflows float64.
 *   - Rounding is to exactly 3 decimal places; no implicit truncation.
 *   - `totalsToSnapshot` produces plain `number` values (JSON safe).
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeCartTotals, totalsToSnapshot } from '../src/index.js';
import { makeCartLine } from './fixtures.js';
import type { ProductType } from '../src/index.js';

describe('computeCartTotals — category mapping', () => {
  it.each<[ProductType, 'flower' | 'concentrate' | 'edibleThc']>([
    ['flower', 'flower'],
    ['preroll', 'flower'],
    ['infused_preroll', 'flower'],
    ['vape', 'concentrate'],
    ['concentrate', 'concentrate'],
    ['edible', 'edibleThc'],
    ['beverage', 'edibleThc'],
    ['tincture', 'edibleThc'],
  ])('rolls %s into the %s bucket', (productType, bucket) => {
    const cart = [
      makeCartLine({
        productType,
        quantity: 1,
        weightGramsPerUnit: new Decimal('1'),
        thcMgPerUnit: new Decimal('1'),
      }),
    ];

    const totals = computeCartTotals(cart);

    if (bucket === 'flower') {
      expect(totals.flowerGrams.toString()).toBe('1');
      expect(totals.concentrateGrams.toString()).toBe('0');
      expect(totals.edibleThcMg.toString()).toBe('0');
    } else if (bucket === 'concentrate') {
      expect(totals.flowerGrams.toString()).toBe('0');
      expect(totals.concentrateGrams.toString()).toBe('1');
      expect(totals.edibleThcMg.toString()).toBe('0');
    } else {
      expect(totals.flowerGrams.toString()).toBe('0');
      expect(totals.concentrateGrams.toString()).toBe('0');
      expect(totals.edibleThcMg.toString()).toBe('1');
    }
  });

  it.each<ProductType>(['topical', 'accessory', 'seed', 'clone'])(
    'treats %s as exempt — does not contribute to any cap',
    (productType) => {
      const cart = [
        makeCartLine({
          productType,
          quantity: 100,
          weightGramsPerUnit: new Decimal('1000'),
          thcMgPerUnit: new Decimal('1000'),
        }),
      ];

      const totals = computeCartTotals(cart);

      expect(totals.flowerGrams.toString()).toBe('0');
      expect(totals.concentrateGrams.toString()).toBe('0');
      expect(totals.edibleThcMg.toString()).toBe('0');
    },
  );
});

describe('computeCartTotals — precision', () => {
  it('sums 56 pre-rolls × 0.1g to exactly 5.6g (would drift in float)', () => {
    // 0.1 * 56 in float64 = 5.6000000000000005. Decimal must produce 5.6.
    const cart = [
      makeCartLine({
        productType: 'preroll',
        quantity: 56,
        weightGramsPerUnit: new Decimal('0.1'),
      }),
    ];

    const totals = computeCartTotals(cart);

    expect(totals.flowerGrams.toString()).toBe('5.6');
  });

  it('sums multiple lines without precision loss', () => {
    // 0.1 + 0.2 in float64 = 0.30000000000000004. Decimal must produce 0.3.
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('0.1'),
      }),
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('0.2'),
      }),
    ];

    const totals = computeCartTotals(cart);

    expect(totals.flowerGrams.toString()).toBe('0.3');
  });

  it('rounds to 3 decimal places (matches MN OCM reporting precision)', () => {
    // 1/7 g × 7 → mathematically 1g, but with non-terminating decimals
    // the per-line value rounds. We force this by using a 4-dp input.
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('1.23456'),
      }),
    ];

    const totals = computeCartTotals(cart);

    expect(totals.flowerGrams.toString()).toBe('1.235');
  });

  it('returns the canonical Decimal zero on an empty cart', () => {
    const totals = computeCartTotals([]);

    expect(totals.flowerGrams.equals(0)).toBe(true);
    expect(totals.concentrateGrams.equals(0)).toBe(true);
    expect(totals.edibleThcMg.equals(0)).toBe(true);
  });
});

describe('computeCartTotals — multi-category mixed cart', () => {
  it('accumulates each category independently', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('14'),
      }),
      makeCartLine({
        productType: 'vape',
        quantity: 2,
        weightGramsPerUnit: new Decimal('0.5'),
      }),
      makeCartLine({
        productType: 'beverage',
        quantity: 2,
        thcMgPerUnit: new Decimal('10'),
      }),
      makeCartLine({
        productType: 'accessory',
        quantity: 1,
        weightGramsPerUnit: new Decimal('500'),
        thcMgPerUnit: new Decimal('500'),
      }),
    ];

    const totals = computeCartTotals(cart);

    expect(totals.flowerGrams.toString()).toBe('14');
    expect(totals.concentrateGrams.toString()).toBe('1');
    expect(totals.edibleThcMg.toString()).toBe('20');
  });
});

describe('totalsToSnapshot', () => {
  it('converts Decimal totals into plain numbers for JSON persistence', () => {
    const totals = computeCartTotals([
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('14'),
      }),
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('2.5'),
      }),
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('100'),
      }),
    ]);

    const snapshot = totalsToSnapshot(totals);

    expect(snapshot).toEqual({
      flowerGrams: 14,
      concentrateGrams: 2.5,
      edibleThcMg: 100,
    });
    expect(typeof snapshot.flowerGrams).toBe('number');
    expect(typeof snapshot.concentrateGrams).toBe('number');
    expect(typeof snapshot.edibleThcMg).toBe('number');
  });

  it('snapshots zeros for an empty cart', () => {
    const snapshot = totalsToSnapshot(computeCartTotals([]));

    expect(snapshot).toEqual({
      flowerGrams: 0,
      concentrateGrams: 0,
      edibleThcMg: 0,
    });
  });
});
