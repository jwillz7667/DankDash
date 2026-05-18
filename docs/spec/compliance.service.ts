/**
 * compliance.service.ts
 *
 * Reference implementation of DankDash's compliance engine.
 * Every order placement runs through ComplianceService.evaluateCart.
 *
 * Design principles:
 *   1. Pure functions where possible — easy to test, easy to reason about
 *   2. Every rule produces a structured result (not just true/false)
 *   3. Limits are constants pulled from MN statute; statute citations in comments
 *   4. Fail closed: if anything errors, treat as non-compliant
 *   5. Snapshot the evaluation onto the order for audit purposes
 */

import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

// Minnesota statutory limits — Minn. Stat. § 342.27(c)
// "during a single transaction"
const MN_PER_TRANSACTION_LIMITS = {
  flowerGramsMax: 56.7,          // 2 ounces, exact conversion
  concentrateGramsMax: 8.0,       // 8 grams
  edibleThcMgMax: 800.0,          // 800 mg total THC across edibles
} as const;

// Minn. Stat. § 342.27 — no sales 2:00 AM – 8:00 AM
const MN_SALES_HOURS = {
  earliestOpen: { hour: 8, minute: 0 },
  latestClose: { hour: 26, minute: 0 }, // 2 AM next day, represented as h>24
} as const;

// Minn. Stat. § 342.27(e) — beverages
const MN_BEVERAGE_LIMITS = {
  thcMgPerServingMax: 10,
  servingsPerContainerMax: 2,
} as const;

export type RuleId =
  | 'age'
  | 'kyc'
  | 'hours'
  | 'per_transaction_limit'
  | 'delivery_geofence'
  | 'dispensary_license'
  | 'product_provenance';

export interface RuleResult {
  rule: RuleId;
  passed: boolean;
  details: Record<string, unknown>;
}

export interface ComplianceEvaluation {
  passed: boolean;
  rules: RuleResult[];
  cartTotals: {
    flowerGrams: number;
    concentrateGrams: number;
    edibleThcMg: number;
  };
  limits: typeof MN_PER_TRANSACTION_LIMITS;
  evaluatedAt: string;            // ISO timestamp
  evaluationVersion: string;      // bump when rules change
}

export interface CartLineForEvaluation {
  productType:
    | 'flower' | 'preroll' | 'infused_preroll' | 'vape'
    | 'edible' | 'beverage' | 'concentrate' | 'tincture'
    | 'topical' | 'accessory' | 'seed' | 'clone';
  quantity: number;
  thcMgPerUnit: number;
  weightGramsPerUnit: number;
  thcMgPerServing?: number | null;
  servingCount?: number | null;
}

export interface EvaluationContext {
  user: {
    id: string;
    dateOfBirth: Date | null;
    kycVerifiedAt: Date | null;
  };
  dispensary: {
    id: string;
    licenseExpiresAt: Date;
    hoursJson: Record<string, { open: string; close: string } | null>;
    deliveryPolygon: GeoJSON.Polygon;
    timezone: string;
  };
  deliveryLocation: { latitude: number; longitude: number };
  cart: CartLineForEvaluation[];
  now?: Date; // injected for testability
}

const EVAL_VERSION = '2026-05-17.1';

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  evaluateCart(ctx: EvaluationContext): ComplianceEvaluation {
    const now = ctx.now ?? new Date();
    const results: RuleResult[] = [];

    try {
      results.push(this.checkAge(ctx, now));
      results.push(this.checkKyc(ctx));
      results.push(this.checkDispensaryLicense(ctx, now));
      results.push(this.checkHours(ctx, now));
      results.push(this.checkGeofence(ctx));
      results.push(this.checkPerTransactionLimits(ctx));
      results.push(this.checkProductProvenance(ctx));
    } catch (err) {
      // FAIL CLOSED — never let an exception result in a "passed" evaluation
      this.logger.error('Compliance evaluation threw', err);
      return {
        passed: false,
        rules: [
          ...results,
          {
            rule: 'per_transaction_limit',
            passed: false,
            details: { error: 'evaluation_exception' },
          },
        ],
        cartTotals: { flowerGrams: 0, concentrateGrams: 0, edibleThcMg: 0 },
        limits: MN_PER_TRANSACTION_LIMITS,
        evaluatedAt: now.toISOString(),
        evaluationVersion: EVAL_VERSION,
      };
    }

    const totals = this.computeCartTotals(ctx.cart);
    const passed = results.every((r) => r.passed);

    return {
      passed,
      rules: results,
      cartTotals: totals,
      limits: MN_PER_TRANSACTION_LIMITS,
      evaluatedAt: now.toISOString(),
      evaluationVersion: EVAL_VERSION,
    };
  }

  // ---------------------------------------------------------------------------
  // Individual rules
  // ---------------------------------------------------------------------------

  private checkAge(ctx: EvaluationContext, now: Date): RuleResult {
    const dob = ctx.user.dateOfBirth;
    if (!dob) {
      return { rule: 'age', passed: false, details: { reason: 'dob_missing' } };
    }
    const age = DateTime.fromJSDate(now).diff(DateTime.fromJSDate(dob), 'years').years;
    return {
      rule: 'age',
      passed: age >= 21,
      details: { age: Math.floor(age), minimum: 21 },
    };
  }

  private checkKyc(ctx: EvaluationContext): RuleResult {
    return {
      rule: 'kyc',
      passed: ctx.user.kycVerifiedAt !== null,
      details: {
        verified: ctx.user.kycVerifiedAt !== null,
        verifiedAt: ctx.user.kycVerifiedAt?.toISOString() ?? null,
      },
    };
  }

  private checkDispensaryLicense(ctx: EvaluationContext, now: Date): RuleResult {
    const expires = ctx.dispensary.licenseExpiresAt;
    const passed = expires > now;
    return {
      rule: 'dispensary_license',
      passed,
      details: { expiresAt: expires.toISOString() },
    };
  }

  private checkHours(ctx: EvaluationContext, now: Date): RuleResult {
    const localNow = DateTime.fromJSDate(now, { zone: ctx.dispensary.timezone });
    const dayKey = localNow.weekdayLong!.toLowerCase().slice(0, 3); // mon, tue, ...
    const todays = ctx.dispensary.hoursJson[dayKey];

    if (!todays) {
      return { rule: 'hours', passed: false, details: { reason: 'closed_today' } };
    }

    const [openH, openM] = todays.open.split(':').map(Number);
    const [closeH, closeM] = todays.close.split(':').map(Number);

    const openAt = localNow.set({ hour: openH, minute: openM, second: 0 });
    let closeAt = localNow.set({ hour: closeH, minute: closeM, second: 0 });
    if (closeH < openH) {
      // close is "next day", e.g. 02:00
      closeAt = closeAt.plus({ days: 1 });
    }

    // Apply state-level cap: between 8:00 and 26:00 local
    const stateEarliest = localNow.set({
      hour: MN_SALES_HOURS.earliestOpen.hour,
      minute: MN_SALES_HOURS.earliestOpen.minute,
      second: 0,
    });
    const stateLatest = localNow.set({
      hour: MN_SALES_HOURS.latestClose.hour % 24,
      minute: MN_SALES_HOURS.latestClose.minute,
      second: 0,
    }).plus({ days: MN_SALES_HOURS.latestClose.hour >= 24 ? 1 : 0 });

    const effectiveOpen = openAt < stateEarliest ? stateEarliest : openAt;
    const effectiveClose = closeAt > stateLatest ? stateLatest : closeAt;

    const passed = localNow >= effectiveOpen && localNow < effectiveClose;

    return {
      rule: 'hours',
      passed,
      details: {
        localNow: localNow.toISO(),
        effectiveOpen: effectiveOpen.toISO(),
        effectiveClose: effectiveClose.toISO(),
      },
    };
  }

  private checkGeofence(ctx: EvaluationContext): RuleResult {
    const inside = pointInPolygon(
      [ctx.deliveryLocation.longitude, ctx.deliveryLocation.latitude],
      ctx.dispensary.deliveryPolygon,
    );
    return {
      rule: 'delivery_geofence',
      passed: inside,
      details: {
        deliveryLocation: ctx.deliveryLocation,
      },
    };
  }

  private checkPerTransactionLimits(ctx: EvaluationContext): RuleResult {
    const totals = this.computeCartTotals(ctx.cart);
    const violations: string[] = [];

    if (totals.flowerGrams > MN_PER_TRANSACTION_LIMITS.flowerGramsMax) {
      violations.push('flower');
    }
    if (totals.concentrateGrams > MN_PER_TRANSACTION_LIMITS.concentrateGramsMax) {
      violations.push('concentrate');
    }
    if (totals.edibleThcMg > MN_PER_TRANSACTION_LIMITS.edibleThcMgMax) {
      violations.push('edibles');
    }

    return {
      rule: 'per_transaction_limit',
      passed: violations.length === 0,
      details: { totals, limits: MN_PER_TRANSACTION_LIMITS, violations },
    };
  }

  private checkProductProvenance(ctx: EvaluationContext): RuleResult {
    // Beverage potency cap (Minn. Stat. § 342.27(e))
    for (const line of ctx.cart) {
      if (line.productType === 'beverage') {
        if ((line.thcMgPerServing ?? 0) > MN_BEVERAGE_LIMITS.thcMgPerServingMax) {
          return {
            rule: 'product_provenance',
            passed: false,
            details: { reason: 'beverage_potency_exceeds_cap' },
          };
        }
        if ((line.servingCount ?? 0) > MN_BEVERAGE_LIMITS.servingsPerContainerMax) {
          return {
            rule: 'product_provenance',
            passed: false,
            details: { reason: 'beverage_servings_exceeds_cap' },
          };
        }
      }
    }
    return { rule: 'product_provenance', passed: true, details: {} };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private computeCartTotals(cart: CartLineForEvaluation[]) {
    let flowerGrams = 0;
    let concentrateGrams = 0;
    let edibleThcMg = 0;

    for (const line of cart) {
      const qty = line.quantity;

      switch (line.productType) {
        case 'flower':
        case 'preroll':
        case 'infused_preroll':
          flowerGrams += qty * line.weightGramsPerUnit;
          // Infused pre-rolls also count toward edibles-equivalent THC?
          // Per MN guidance, infused pre-rolls count toward the flower limit
          // because they are smokable; the added THC is captured in concentrate
          // category if the manufacturer reports it that way. We default to
          // flower-only for the calculator and let lab data drive product_type.
          break;
        case 'concentrate':
        case 'vape':
          concentrateGrams += qty * line.weightGramsPerUnit;
          break;
        case 'edible':
        case 'beverage':
        case 'tincture':
          edibleThcMg += qty * line.thcMgPerUnit;
          break;
        case 'topical':
        case 'accessory':
        case 'seed':
        case 'clone':
          // Not subject to potency limits
          break;
      }
    }

    return {
      flowerGrams: round3(flowerGrams),
      concentrateGrams: round3(concentrateGrams),
      edibleThcMg: round3(edibleThcMg),
    };
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Ray-casting point-in-polygon. In production, this is delegated to PostGIS
 * via `ST_Contains` at the SQL layer; this implementation exists so the
 * compliance service can be unit-tested without a DB.
 */
function pointInPolygon(
  point: [number, number],
  polygon: GeoJSON.Polygon,
): boolean {
  const [x, y] = point;
  const ring = polygon.coordinates[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
