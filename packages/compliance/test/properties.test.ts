/**
 * Property-based tests for the compliance engine.
 *
 * Unit tests pin specific cases; these pin invariants — claims that must
 * hold for ALL carts in the input space the engine accepts. fast-check
 * generates ~hundreds of carts per property and shrinks failures to a
 * minimal counterexample.
 *
 * Properties covered:
 *
 *   1. checkPerTransactionLimits is the cap-arithmetic spec, restated.
 *      For any cart, `passed` iff every cap-category total is ≤ its limit.
 *   2. computeCartTotals is order-invariant (commutative across lines).
 *   3. computeCartTotals partitions associatively (totals(a ++ b) = totals(a) + totals(b)).
 *   4. Exempt products are total-neutral (appending any number of
 *      topicals/accessories/seeds/clones never changes the running totals).
 *   5. Geofence: for any cart, an interstate delivery always fails the
 *      delivery_geofence rule — federal trafficking line, no exceptions.
 *   6. evaluateCart is deterministic for a fixed `now` — same input
 *      yields a byte-identical JSON snapshot.
 */
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkPerTransactionLimits,
  computeCartTotals,
  evaluateCart,
  MN_PER_TRANSACTION_LIMITS,
} from '../src/index.js';
import { DES_MOINES_IA, FARGO_ND, HUDSON_WI, makeContext, SIOUX_FALLS_SD } from './fixtures.js';
import type { CartLine, ProductType } from '../src/index.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const PRODUCT_TYPES: readonly ProductType[] = [
  'flower',
  'preroll',
  'infused_preroll',
  'vape',
  'concentrate',
  'edible',
  'beverage',
  'tincture',
  'topical',
  'accessory',
  'seed',
  'clone',
];

const EXEMPT_TYPES: readonly ProductType[] = ['topical', 'accessory', 'seed', 'clone'];

/**
 * Bounded positive Decimal arbitrary. Rounded to 3 decimal places to avoid
 * fast-check generating values whose float64 representation has more
 * precision than the engine's totals (which round to 3 dp).
 */
function decimalArb(max: number): fc.Arbitrary<Decimal> {
  return fc
    .float({ min: 0, max, noNaN: true, noDefaultInfinity: true })
    .map((value) => new Decimal(value.toFixed(3)));
}

const cartLineArb: fc.Arbitrary<CartLine> = fc
  .tuple(
    fc.uuid(),
    fc.constantFrom(...PRODUCT_TYPES),
    fc.integer({ min: 1, max: 100 }),
    decimalArb(100),
    decimalArb(1000),
  )
  .map(([id, productType, quantity, weightGramsPerUnit, thcMgPerUnit]) => ({
    id,
    productType,
    quantity,
    weightGramsPerUnit,
    thcMgPerUnit,
    thcMgPerServing: null,
    servingCount: null,
  }));

const cartArb: fc.Arbitrary<CartLine[]> = fc.array(cartLineArb, { maxLength: 20 });

const exemptLineArb: fc.Arbitrary<CartLine> = fc
  .tuple(
    fc.uuid(),
    fc.constantFrom(...EXEMPT_TYPES),
    fc.integer({ min: 1, max: 100 }),
    decimalArb(1000),
    decimalArb(1000),
  )
  .map(([id, productType, quantity, weightGramsPerUnit, thcMgPerUnit]) => ({
    id,
    productType,
    quantity,
    weightGramsPerUnit,
    thcMgPerUnit,
    thcMgPerServing: null,
    servingCount: null,
  }));

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property — checkPerTransactionLimits is the cap-arithmetic spec', () => {
  it('passes iff every cap-category total stays at or below its statutory cap', () => {
    fc.assert(
      fc.property(cartArb, (cart) => {
        const totals = computeCartTotals(cart);
        const expectPass =
          totals.flowerGrams.lessThanOrEqualTo(MN_PER_TRANSACTION_LIMITS.flowerGramsMax) &&
          totals.concentrateGrams.lessThanOrEqualTo(
            MN_PER_TRANSACTION_LIMITS.concentrateGramsMax,
          ) &&
          totals.edibleThcMg.lessThanOrEqualTo(MN_PER_TRANSACTION_LIMITS.edibleThcMgMax);

        const res = checkPerTransactionLimits(makeContext({ cart }));

        expect(res.passed).toBe(expectPass);
      }),
      { numRuns: 500 },
    );
  });
});

describe('property — computeCartTotals is order-invariant', () => {
  it('produces the same totals regardless of line ordering', () => {
    fc.assert(
      fc.property(cartArb, (cart) => {
        const shuffled = [...cart].reverse();
        const a = computeCartTotals(cart);
        const b = computeCartTotals(shuffled);

        expect(a.flowerGrams.toString()).toBe(b.flowerGrams.toString());
        expect(a.concentrateGrams.toString()).toBe(b.concentrateGrams.toString());
        expect(a.edibleThcMg.toString()).toBe(b.edibleThcMg.toString());
      }),
      { numRuns: 200 },
    );
  });
});

describe('property — computeCartTotals partitions associatively', () => {
  it('totals(a ++ b) equals totals(a) + totals(b) (Decimal-exact)', () => {
    fc.assert(
      fc.property(cartArb, cartArb, (a, b) => {
        const whole = computeCartTotals([...a, ...b]);
        const left = computeCartTotals(a);
        const right = computeCartTotals(b);

        // Sum each cap and re-round to 3 dp to match the engine's behaviour.
        const expectedFlower = left.flowerGrams.plus(right.flowerGrams).toDecimalPlaces(3);
        const expectedConcentrate = left.concentrateGrams
          .plus(right.concentrateGrams)
          .toDecimalPlaces(3);
        const expectedEdible = left.edibleThcMg.plus(right.edibleThcMg).toDecimalPlaces(3);

        expect(whole.flowerGrams.toString()).toBe(expectedFlower.toString());
        expect(whole.concentrateGrams.toString()).toBe(expectedConcentrate.toString());
        expect(whole.edibleThcMg.toString()).toBe(expectedEdible.toString());
      }),
      { numRuns: 200 },
    );
  });
});

describe('property — exempt products are total-neutral', () => {
  it('appending any number of exempt lines does not change cap totals', () => {
    fc.assert(
      fc.property(cartArb, fc.array(exemptLineArb, { maxLength: 10 }), (cart, exemptLines) => {
        const before = computeCartTotals(cart);
        const after = computeCartTotals([...cart, ...exemptLines]);

        expect(after.flowerGrams.toString()).toBe(before.flowerGrams.toString());
        expect(after.concentrateGrams.toString()).toBe(before.concentrateGrams.toString());
        expect(after.edibleThcMg.toString()).toBe(before.edibleThcMg.toString());
      }),
      { numRuns: 200 },
    );
  });
});

describe('property — interstate deliveries always fail the geofence rule', () => {
  const INTERSTATE = [HUDSON_WI, FARGO_ND, SIOUX_FALLS_SD, DES_MOINES_IA] as const;

  it('regardless of cart contents or other context, the overall eval is false', () => {
    fc.assert(
      fc.property(cartArb, fc.constantFrom(...INTERSTATE), (cart, deliveryLocation) => {
        const ctx = makeContext({ cart, deliveryLocation });

        const evalResult = evaluateCart(ctx);
        const geofence = evalResult.rules.find((r) => r.rule === 'delivery_geofence');

        expect(geofence?.passed).toBe(false);
        expect(evalResult.passed).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property — evaluateCart is deterministic for a fixed now', () => {
  it('produces a byte-identical JSON snapshot across repeated runs', () => {
    fc.assert(
      fc.property(cartArb, (cart) => {
        const ctx = makeContext({ cart });

        const a = JSON.stringify(evaluateCart(ctx));
        const b = JSON.stringify(evaluateCart(ctx));

        expect(a).toBe(b);
      }),
      { numRuns: 50 },
    );
  });
});
