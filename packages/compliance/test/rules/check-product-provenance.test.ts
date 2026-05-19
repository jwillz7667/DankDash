/**
 * Product-provenance rule. Today this only covers the cannabis-beverage
 * gates from Minn. Stat. § 342.27, subd. (e): ≤ 10 mg THC per serving
 * and ≤ 2 servings per container. The rule walks every cart line so a
 * mixed-bad cart produces violations for every offender.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkProductProvenance } from '../../src/index.js';
import { makeCartLine, makeContext } from '../fixtures.js';

describe('checkProductProvenance', () => {
  it('passes a beverage with 10 mg/serving and 2 servings (at the caps)', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('10'),
        servingCount: 2,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(true);
  });

  it('fails a beverage with 11 mg/serving', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('11'),
        servingCount: 1,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual([
      expect.objectContaining({ reason: 'beverage_potency_exceeds_cap', value: 11, cap: 10 }),
    ]);
  });

  it('fails a beverage with 3 servings', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('5'),
        servingCount: 3,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual([
      expect.objectContaining({ reason: 'beverage_servings_exceeds_cap', value: 3, cap: 2 }),
    ]);
  });

  it('fails (data integrity) when thcMgPerServing is null on a beverage', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: null,
        servingCount: 1,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual([
      expect.objectContaining({ reason: 'beverage_thc_per_serving_missing' }),
    ]);
  });

  it('fails (data integrity) when servingCount is null on a beverage', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('5'),
        servingCount: null,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(false);
    expect(res.details['violations']).toEqual([
      expect.objectContaining({ reason: 'beverage_serving_count_missing' }),
    ]);
  });

  it('skips non-beverage lines entirely', () => {
    const cart = [
      makeCartLine({
        productType: 'edible',
        thcMgPerServing: null,
        servingCount: null,
      }),
      makeCartLine({
        productType: 'flower',
        weightGramsPerUnit: new Decimal('14'),
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(true);
    expect(res.details['violations']).toEqual([]);
  });

  it('collects violations from every offending beverage line', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('15'),
        servingCount: 1,
      }),
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('5'),
        servingCount: 5,
      }),
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: null,
        servingCount: null,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    expect(res.passed).toBe(false);
    const violations = res.details['violations'] as ReadonlyArray<Record<string, unknown>>;
    // 4 violations: 1 over-potency, 1 over-servings, 1 missing potency, 1 missing servings
    expect(violations).toHaveLength(4);
  });

  it('records both potency and servings violations for a single bad line', () => {
    const cart = [
      makeCartLine({
        productType: 'beverage',
        thcMgPerServing: new Decimal('20'),
        servingCount: 5,
      }),
    ];
    const res = checkProductProvenance(makeContext({ cart }));
    const violations = res.details['violations'] as ReadonlyArray<Record<string, unknown>>;
    expect(violations).toHaveLength(2);
  });

  it('passes an empty cart', () => {
    const res = checkProductProvenance(makeContext({ cart: [] }));
    expect(res.passed).toBe(true);
  });
});
