/**
 * Performance gate for `evaluateCart`.
 *
 * Spec target: < 5 ms p99 with a 50-line cart on a modern dev machine.
 * That budget is what the checkout endpoint can spend re-running the
 * engine inside the order-creating transaction without breaking the
 * 250 ms p95 API budget from CLAUDE.md.
 *
 * Methodology: warm up the engine (let v8 inline the hot paths), then
 * measure 1000 cold(-ish) iterations with `performance.now()`. p99 is the
 * 990th-fastest of 1000 samples — the canonical sample-rank estimator.
 *
 * The CI threshold is intentionally looser than the spec target: shared
 * GitHub runners routinely spike single iterations into the 10–20 ms
 * range from noisy-neighbour CPU pressure, which pushes p99 well above
 * 5 ms even when the engine itself is healthy. We gate at 25 ms p99 to
 * stay loud about real regressions (a 5× slowdown of the actual work
 * would land around 50 ms) without flaking on infrastructure noise. The
 * printed actuals are the early-warning signal — if you see them creep
 * up commit-over-commit, treat that as the regression, not the gate.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { evaluateCart } from '../src/index.js';
import { makeCartLine, makeContext } from './fixtures.js';
import type { CartLine, ProductType } from '../src/index.js';

const P99_BUDGET_MS = 25;
const ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

function buildFiftyLineCart(): CartLine[] {
  // A realistic mix that exercises every cap category plus exempt lines.
  // Sized so every cap stays under its statutory limit (the engine still
  // runs every rule regardless of pass/fail, so this only affects the
  // arithmetic, not the work).
  const cart: CartLine[] = [];
  const types: ProductType[] = [
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
  ];
  for (let i = 0; i < 50; i++) {
    const productType = types[i % types.length] ?? 'flower';
    cart.push(
      makeCartLine({
        productType,
        quantity: 1,
        weightGramsPerUnit: new Decimal('0.5'),
        thcMgPerUnit: new Decimal('5'),
      }),
    );
  }
  return cart;
}

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError('cannot take percentile of empty sample');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, rank));
  const value = sorted[clamped];
  if (value === undefined) {
    throw new RangeError('percentile rank out of bounds (unreachable)');
  }
  return value;
}

describe('performance — evaluateCart', () => {
  it(`runs a 50-line cart in under ${P99_BUDGET_MS}ms p99`, () => {
    const cart = buildFiftyLineCart();
    const ctx = makeContext({ cart });

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      evaluateCart(ctx);
    }

    const samples: number[] = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      evaluateCart(ctx);
      samples[i] = performance.now() - start;
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const p99 = percentile(samples, 99);

    // Surface the actual numbers so a regression is visible in test output
    // even when it doesn't blow the budget.

    console.log(
      `evaluateCart 50-line cart: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );

    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });
});
