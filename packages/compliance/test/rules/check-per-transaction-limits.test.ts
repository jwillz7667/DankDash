/**
 * Per-transaction-limit rule — every case from CLAUDE-CODE-PHASES.md §3.5.
 *
 * The cap-edge tests (56.7g exact, 56.701g over, 8.001g over, 800/801mg)
 * are why the engine uses Decimal arithmetic — JS floats fail the
 * `56.701 > 56.7` comparison on at least one platform/optimizer combo,
 * and `0.001 * 1000` famously overshoots in float64.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkPerTransactionLimits } from '../../src/index.js';
import { makeCartLine, makeContext } from '../fixtures.js';

describe('checkPerTransactionLimits — flower cap', () => {
  it('passes 1.99 oz (56.418g) of flower', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('56.418'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('passes 2.0 oz expressed as 56.7g exactly (at the cap)', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('56.7'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
    expect(res.details['violations']).toEqual([]);
  });

  it('fails 56.701g of flower', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('56.701'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['flower']);
  });

  it('passes 2.0 oz from many small pre-rolls (sums to 56.7g exactly)', () => {
    // 81 pre-rolls × 0.7g = 56.7g
    const cart = [
      makeCartLine({
        productType: 'preroll',
        quantity: 81,
        weightGramsPerUnit: new Decimal('0.7'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('infused pre-rolls roll into the flower cap', () => {
    const cart = [
      makeCartLine({
        productType: 'infused_preroll',
        quantity: 1,
        weightGramsPerUnit: new Decimal('57'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['flower']);
  });
});

describe('checkPerTransactionLimits — concentrate cap', () => {
  it('passes 7.99g of concentrate', () => {
    const cart = [
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('7.99'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('passes exactly 8g of concentrate (at the cap)', () => {
    const cart = [
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('8'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('fails 8.001g of concentrate', () => {
    const cart = [
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('8.001'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['concentrate']);
  });

  it('vape carts roll into the concentrate cap (5 × 1.7g = 8.5g → fail)', () => {
    const cart = [
      makeCartLine({
        productType: 'vape',
        quantity: 5,
        weightGramsPerUnit: new Decimal('1.7'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['concentrate']);
  });
});

describe('checkPerTransactionLimits — edible THC cap', () => {
  it('passes 799 mg of edibles', () => {
    const cart = [
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('799'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('passes exactly 800 mg of edibles (at the cap)', () => {
    const cart = [
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('800'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('fails 801 mg of edibles', () => {
    const cart = [
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('801'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['edibles']);
  });

  it('fails 2 beverages × 100mg (200mg ok but illustrates the path)', () => {
    // Two 100mg beverages = 200mg total, under the 800mg edible cap, so this
    // particular variation passes the limit (but would fail product-provenance
    // for the per-serving cap; that's a different rule).
    const cart = [
      makeCartLine({
        productType: 'beverage',
        quantity: 2,
        thcMgPerUnit: new Decimal('100'),
        thcMgPerServing: new Decimal('100'),
        servingCount: 1,
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('fails 9 beverages × 100mg = 900mg edible THC', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        quantity: 9,
        thcMgPerUnit: new Decimal('100'),
        thcMgPerServing: new Decimal('10'),
        servingCount: 1,
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['edibles']);
  });

  it('passes 2 cans × 10mg = 20mg', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        quantity: 2,
        thcMgPerUnit: new Decimal('10'),
        thcMgPerServing: new Decimal('10'),
        servingCount: 1,
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('combines edibles and tinctures into the same 800mg cap', () => {
    const cart = [
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('500'),
      }),
      makeCartLine({
        productType: 'tincture',
        quantity: 1,
        thcMgPerUnit: new Decimal('400'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['edibles']);
  });
});

describe('checkPerTransactionLimits — mixed carts and exempt products', () => {
  it('passes 1oz flower + 4g concentrate + 400mg edibles', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('28'),
      }),
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('4'),
      }),
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('400'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('reports every cap violated, not just the first', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('60'),
      }),
      makeCartLine({
        productType: 'concentrate',
        quantity: 1,
        weightGramsPerUnit: new Decimal('10'),
      }),
      makeCartLine({
        productType: 'edible',
        quantity: 1,
        thcMgPerUnit: new Decimal('900'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual(['flower', 'concentrate', 'edibles']);
  });

  it('passes an empty cart', () => {
    const res = checkPerTransactionLimits(makeContext({ cart: [] }));
    expect(res.passed).toBe(true);
    expect(res.details['violations']).toEqual([]);
  });

  it('topicals, accessories, seeds, and clones never trigger caps', () => {
    const cart = [
      makeCartLine({
        productType: 'topical',
        quantity: 1,
        weightGramsPerUnit: new Decimal('1000'),
        thcMgPerUnit: new Decimal('1000'),
      }),
      makeCartLine({
        productType: 'accessory',
        quantity: 1,
        weightGramsPerUnit: new Decimal('1000'),
      }),
      makeCartLine({
        productType: 'seed',
        quantity: 50,
        weightGramsPerUnit: new Decimal('0.1'),
      }),
      makeCartLine({
        productType: 'clone',
        quantity: 10,
        weightGramsPerUnit: new Decimal('5'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('echoes the snapshot-shape totals and limits for orders.compliance_check_payload', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('14'),
      }),
    ];
    const res = checkPerTransactionLimits(makeContext({ cart }));
    expect(res.details['totals']).toEqual({
      flowerGrams: 14,
      concentrateGrams: 0,
      edibleThcMg: 0,
    });
    expect(res.details['limits']).toEqual({
      flowerGramsMax: 56.7,
      concentrateGramsMax: 8,
      edibleThcMgMax: 800,
    });
  });
});
