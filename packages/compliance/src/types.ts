/**
 * Domain types for the compliance engine.
 *
 * Shapes here are framework-free — no NestJS, no Drizzle, no HTTP. The
 * engine accepts a plain `EvaluationContext` value and returns a plain
 * `ComplianceEvaluation`; how the API or workers obtain that context is
 * not this package's concern.
 *
 * Weight and THC quantities used during evaluation are `Decimal` for exact
 * arithmetic — the cart-math layer aggregates them, the rules compare them
 * against the constants. The persisted snapshot (`ComplianceEvaluation`)
 * exposes plain `number` values because it lives in `orders.compliance_check_payload`
 * as JSONB and downstream consumers (auditors, the iOS receipt view) only
 * read those numbers, never re-aggregate them.
 */
import type { Decimal } from 'decimal.js';
import type { Polygon } from 'geojson';

// ---------------------------------------------------------------------------
// Cart lines
// ---------------------------------------------------------------------------

/**
 * Product categories recognized by the engine. Mirrors the
 * `product_type` enum in `docs/spec/schema.sql`. Category aggregation
 * (e.g. vape carts roll into the concentrate cap) is defined in
 * `cart-math.ts`.
 *
 * Three product types are exempt from potency caps:
 *   - `topical` — non-ingestible
 *   - `accessory` — non-cannabis (papers, pipes)
 *   - `seed` / `clone` — agricultural; covered by separate horticultural
 *     rules outside the per-transaction limit framework.
 */
export type ProductType =
  | 'flower'
  | 'preroll'
  | 'infused_preroll'
  | 'vape'
  | 'edible'
  | 'beverage'
  | 'concentrate'
  | 'tincture'
  | 'topical'
  | 'accessory'
  | 'seed'
  | 'clone';

/**
 * A single line in the cart being evaluated. `id` is the catalog SKU or
 * cart-item id — included so rule failures can name the offending line in
 * their `details` payload, which lets the iOS client highlight it.
 *
 * `thcMgPerServing` and `servingCount` are present (nullable) on every
 * line because beverage validation reads them. For non-beverage products
 * they are null. A null on a beverage line is a data-integrity failure
 * and the product-provenance rule fails closed on it.
 */
export interface CartLine {
  readonly id: string;
  readonly productType: ProductType;
  readonly quantity: number;
  readonly weightGramsPerUnit: Decimal;
  readonly thcMgPerUnit: Decimal;
  readonly thcMgPerServing: Decimal | null;
  readonly servingCount: number | null;
}

// ---------------------------------------------------------------------------
// Hours of operation
// ---------------------------------------------------------------------------

/**
 * 3-letter lowercase weekday keys, matching the format luxon produces
 * via `DateTime.weekdayLong.slice(0, 3).toLowerCase()`. Stored as a closed
 * union so a `Record<Weekday, ...>` is exhaustive without an index
 * signature.
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * Open/close pair for a single day in the dispensary's local time.
 * Format: `HH:MM` 24-hour. A close time may exceed 24:00 (e.g. `26:00`)
 * to denote a next-day close consistent with `MN_SALES_HOURS.latestClose`.
 * The hours rule parses these defensively and fails closed on malformed
 * values.
 */
export interface DayHours {
  readonly open: string;
  readonly close: string;
}

/** Full weekly schedule. `null` for any day the dispensary is closed. */
export type DispensaryHours = Readonly<Record<Weekday, DayHours | null>>;

// ---------------------------------------------------------------------------
// Cart totals — used internally by rules; converted to plain numbers in
// the persisted snapshot.
// ---------------------------------------------------------------------------

export interface CartTotals {
  readonly flowerGrams: Decimal;
  readonly concentrateGrams: Decimal;
  readonly edibleThcMg: Decimal;
}

// ---------------------------------------------------------------------------
// Evaluation context — input to evaluateCart()
// ---------------------------------------------------------------------------

export interface EvaluationUser {
  readonly id: string;
  readonly dateOfBirth: Date | null;
  readonly kycVerifiedAt: Date | null;
}

export interface EvaluationDispensary {
  readonly id: string;
  readonly licenseExpiresAt: Date;
  readonly hoursJson: DispensaryHours;
  readonly deliveryPolygon: Polygon;
  readonly timezone: string;
}

export interface EvaluationLocation {
  readonly latitude: number;
  readonly longitude: number;
}

export interface EvaluationContext {
  readonly user: EvaluationUser;
  readonly dispensary: EvaluationDispensary;
  readonly deliveryLocation: EvaluationLocation;
  readonly cart: readonly CartLine[];
  /**
   * Injected for testability and to lock the wall-clock used across rules
   * within a single evaluation. When omitted, the engine reads `new Date()`
   * once at the top of `evaluateCart`.
   */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Rule results
// ---------------------------------------------------------------------------

export type RuleId =
  | 'age'
  | 'kyc'
  | 'dispensary_license'
  | 'hours'
  | 'delivery_geofence'
  | 'per_transaction_limit'
  | 'product_provenance'
  /**
   * Sentinel emitted by `evaluateCart` when an internal exception escapes a
   * rule. Never produced by an individual rule — its presence in a snapshot
   * means the engine itself failed and the cart was rejected fail-closed.
   */
  | 'evaluation';

/**
 * Structured detail map attached to each rule result. Always JSON-serializable
 * — the whole evaluation gets persisted to `orders.compliance_check_payload`
 * as JSONB. Rules MUST NOT put `Decimal`, `Date`, or class instances here
 * without converting to a primitive first (string ISO, plain number).
 */
export type RuleDetails = Readonly<Record<string, unknown>>;

export interface RuleResult {
  readonly rule: RuleId;
  readonly passed: boolean;
  readonly details: RuleDetails;
}

// ---------------------------------------------------------------------------
// Snapshot persisted to orders.compliance_check_payload
// ---------------------------------------------------------------------------

/**
 * Plain-number flavor of the per-transaction limits for the persisted
 * snapshot. Built once at the snapshot site by calling `.toNumber()` on
 * the `Decimal` constants in `constants.ts`. The snapshot is read-only
 * audit data; downstream consumers do not re-aggregate against it, so
 * float64 representation is acceptable.
 */
export interface ComplianceLimitsSnapshot {
  readonly flowerGramsMax: number;
  readonly concentrateGramsMax: number;
  readonly edibleThcMgMax: number;
}

export interface ComplianceTotalsSnapshot {
  readonly flowerGrams: number;
  readonly concentrateGrams: number;
  readonly edibleThcMg: number;
}

export interface ComplianceEvaluation {
  readonly passed: boolean;
  readonly rules: readonly RuleResult[];
  readonly cartTotals: ComplianceTotalsSnapshot;
  readonly limits: ComplianceLimitsSnapshot;
  /** ISO-8601 timestamp at which the evaluation was run (UTC). */
  readonly evaluatedAt: string;
  /** Matches `COMPLIANCE_EVALUATION_VERSION` at the time of evaluation. */
  readonly evaluationVersion: string;
}
