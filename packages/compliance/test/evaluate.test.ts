/**
 * Composite tests for `evaluateCart` — the contract that
 * `orders.compliance_check_payload` is built on.
 *
 * The reference spec §3.5 calls for:
 *   - "Cart that passes all rules → overall passed=true"
 *   - "Cart that fails one rule → overall passed=false, only the failing
 *      rule's passed=false"
 *   - "Empty cart → defined behaviour"
 *   - "Exception → fail closed"
 *   - "Determinism across many runs"
 *   - "Snapshot shape matches what the orders table expects"
 *
 * Each case below maps to one of those, plus the format checks the
 * persistence layer relies on (ISO timestamp, version stamp, plain-number
 * totals).
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_EVALUATION_VERSION,
  evaluateCart,
  MN_PER_TRANSACTION_LIMITS,
} from '../src/index.js';
import {
  HUDSON_WI,
  makeCartLine,
  makeContext,
  makeDispensary,
  makeUser,
  MIDDAY_2026_MAY_18,
} from './fixtures.js';
import type { EvaluationContext, RuleId, RuleResult } from '../src/index.js';

/**
 * Test-only Error subclass used to drive the fail-closed `instanceof Error`
 * branch in `evaluateCart`. Subclass (rather than bare `new Error`) so the
 * project's `no-restricted-syntax` rule stays in force across tests too.
 */
class SimulatedUpstreamError extends Error {}

function resultFor(rules: readonly RuleResult[], id: RuleId): RuleResult {
  const found = rules.find((r) => r.rule === id);
  if (found === undefined) expect.fail(`expected rule ${id} in evaluation`);
  return found;
}

describe('evaluateCart — happy path', () => {
  it('passes a fully compliant cart with every rule passing', () => {
    const cart = [
      makeCartLine({
        productType: 'flower',
        quantity: 1,
        weightGramsPerUnit: new Decimal('14'),
      }),
    ];
    const ctx = makeContext({ cart });

    const evalResult = evaluateCart(ctx);

    expect(evalResult.passed).toBe(true);
    for (const rule of evalResult.rules) {
      expect(rule.passed).toBe(true);
    }
  });

  it('emits exactly the seven domain rules in fixed order (no evaluation sentinel)', () => {
    const evalResult = evaluateCart(makeContext({ cart: [] }));

    expect(evalResult.rules.map((r) => r.rule)).toEqual([
      'age',
      'kyc',
      'dispensary_license',
      'hours',
      'delivery_geofence',
      'per_transaction_limit',
      'product_provenance',
    ]);
  });
});

describe('evaluateCart — fails one rule, other rules still evaluated', () => {
  it('flags the under-21 user and still evaluates every other rule', () => {
    const dob = new Date(MIDDAY_2026_MAY_18.getTime() - 365 * 24 * 60 * 60 * 1000 * 20);
    const ctx = makeContext({ user: makeUser({ dateOfBirth: dob }) });

    const evalResult = evaluateCart(ctx);

    expect(evalResult.passed).toBe(false);
    expect(resultFor(evalResult.rules, 'age').passed).toBe(false);
    expect(resultFor(evalResult.rules, 'kyc').passed).toBe(true);
    expect(resultFor(evalResult.rules, 'dispensary_license').passed).toBe(true);
    expect(resultFor(evalResult.rules, 'delivery_geofence').passed).toBe(true);
    expect(resultFor(evalResult.rules, 'per_transaction_limit').passed).toBe(true);
    expect(resultFor(evalResult.rules, 'product_provenance').passed).toBe(true);
  });

  it('flags an interstate delivery without affecting other rule outcomes', () => {
    const ctx = makeContext({ deliveryLocation: HUDSON_WI });

    const evalResult = evaluateCart(ctx);

    expect(evalResult.passed).toBe(false);
    expect(resultFor(evalResult.rules, 'delivery_geofence').passed).toBe(false);
    expect(resultFor(evalResult.rules, 'age').passed).toBe(true);
    expect(resultFor(evalResult.rules, 'kyc').passed).toBe(true);
  });

  it('collects multiple failures in a single evaluation (one round trip)', () => {
    const dob = new Date(MIDDAY_2026_MAY_18.getTime() - 365 * 24 * 60 * 60 * 1000 * 20);
    const ctx = makeContext({
      user: makeUser({ dateOfBirth: dob, kycVerifiedAt: null }),
      deliveryLocation: HUDSON_WI,
      cart: [
        makeCartLine({
          productType: 'flower',
          quantity: 1,
          weightGramsPerUnit: new Decimal('60'),
        }),
      ],
    });

    const evalResult = evaluateCart(ctx);

    expect(evalResult.passed).toBe(false);
    expect(resultFor(evalResult.rules, 'age').passed).toBe(false);
    expect(resultFor(evalResult.rules, 'kyc').passed).toBe(false);
    expect(resultFor(evalResult.rules, 'delivery_geofence').passed).toBe(false);
    expect(resultFor(evalResult.rules, 'per_transaction_limit').passed).toBe(false);
  });
});

describe('evaluateCart — empty cart', () => {
  it('passes an empty cart (nothing to violate; identity/place rules still run)', () => {
    const evalResult = evaluateCart(makeContext({ cart: [] }));

    expect(evalResult.passed).toBe(true);
    expect(evalResult.cartTotals).toEqual({
      flowerGrams: 0,
      concentrateGrams: 0,
      edibleThcMg: 0,
    });
  });
});

describe('evaluateCart — fail-closed on internal exception', () => {
  it('catches a thrown error and emits the evaluation sentinel with passed=false', () => {
    // A Proxy `cart` whose getter throws — simulates corrupted upstream data
    // that survives type checking but blows up in a rule.
    const ctx = makeContext();
    const exploding: EvaluationContext = {
      ...ctx,
      get cart(): never {
        throw new SimulatedUpstreamError('boom: cart exploded');
      },
    };

    const evalResult = evaluateCart(exploding);

    expect(evalResult.passed).toBe(false);
    const sentinel = resultFor(evalResult.rules, 'evaluation');
    expect(sentinel.passed).toBe(false);
    expect(sentinel.details).toEqual({
      reason: 'evaluation_exception',
      message: 'boom: cart exploded',
    });
    expect(evalResult.cartTotals).toEqual({
      flowerGrams: 0,
      concentrateGrams: 0,
      edibleThcMg: 0,
    });
  });

  it('stringifies non-Error thrown values', () => {
    const ctx = makeContext();
    const exploding: EvaluationContext = {
      ...ctx,
      get cart(): never {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'not-an-error';
      },
    };

    const evalResult = evaluateCart(exploding);

    expect(evalResult.passed).toBe(false);
    expect(resultFor(evalResult.rules, 'evaluation').details).toEqual({
      reason: 'evaluation_exception',
      message: 'not-an-error',
    });
  });
});

describe('evaluateCart — snapshot shape (orders.compliance_check_payload)', () => {
  it('stamps a UTC ISO-8601 evaluatedAt and the COMPLIANCE_EVALUATION_VERSION', () => {
    const evalResult = evaluateCart(makeContext({ now: MIDDAY_2026_MAY_18 }));

    expect(evalResult.evaluatedAt).toBe('2026-05-18T17:00:00.000Z');
    expect(evalResult.evaluationVersion).toBe(COMPLIANCE_EVALUATION_VERSION);
  });

  it('exposes plain-number totals and limits (JSON safe)', () => {
    const cart = [
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
    ];

    const evalResult = evaluateCart(makeContext({ cart }));

    expect(evalResult.cartTotals).toEqual({
      flowerGrams: 14,
      concentrateGrams: 2.5,
      edibleThcMg: 100,
    });
    expect(typeof evalResult.cartTotals.flowerGrams).toBe('number');
    expect(typeof evalResult.cartTotals.concentrateGrams).toBe('number');
    expect(typeof evalResult.cartTotals.edibleThcMg).toBe('number');

    expect(evalResult.limits).toEqual({
      flowerGramsMax: MN_PER_TRANSACTION_LIMITS.flowerGramsMax.toNumber(),
      concentrateGramsMax: MN_PER_TRANSACTION_LIMITS.concentrateGramsMax.toNumber(),
      edibleThcMgMax: MN_PER_TRANSACTION_LIMITS.edibleThcMgMax.toNumber(),
    });
  });

  it('round-trips through JSON.stringify without loss', () => {
    const evalResult = evaluateCart(makeContext({ now: MIDDAY_2026_MAY_18 }));

    const roundTripped = JSON.parse(JSON.stringify(evalResult)) as unknown;

    expect(roundTripped).toEqual(evalResult);
  });
});

describe('evaluateCart — wall clock', () => {
  it('reads new Date() when ctx.now is omitted', () => {
    const before = Date.now();
    const ctx: EvaluationContext = {
      user: makeUser(),
      dispensary: makeDispensary(),
      deliveryLocation: { latitude: 44.977, longitude: -93.265 },
      cart: [],
    };

    const evalResult = evaluateCart(ctx);
    const after = Date.now();

    const evaluatedAtMs = Date.parse(evalResult.evaluatedAt);
    expect(evaluatedAtMs).toBeGreaterThanOrEqual(before);
    expect(evaluatedAtMs).toBeLessThanOrEqual(after);
  });

  it('uses the same wall clock across every rule', () => {
    // Age rule and license rule both read `now`. With ctx.now pinned, both
    // see exactly the same instant — verified by reproducibility below.
    const ctx = makeContext({ now: new Date('2026-05-18T17:00:00Z') });

    const first = evaluateCart(ctx);
    const second = evaluateCart(ctx);

    expect(first.evaluatedAt).toBe(second.evaluatedAt);
    expect(first.evaluatedAt).toBe('2026-05-18T17:00:00.000Z');
  });
});

describe('evaluateCart — determinism', () => {
  it('returns the same evaluation across 1000 runs with the same input', () => {
    const ctx = makeContext({
      cart: [
        makeCartLine({
          productType: 'flower',
          quantity: 1,
          weightGramsPerUnit: new Decimal('14'),
        }),
      ],
    });

    const reference = evaluateCart(ctx);
    const referenceJson = JSON.stringify(reference);

    for (let i = 0; i < 1000; i++) {
      const next = evaluateCart(ctx);
      expect(JSON.stringify(next)).toBe(referenceJson);
    }
  });
});
