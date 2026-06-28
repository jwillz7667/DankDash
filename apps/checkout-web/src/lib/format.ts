/**
 * Pure presentation + tip-policy helpers. No I/O, no React — unit-tested in
 * isolation so the money math and the statutory tip floor are pinned.
 */
import { type Compliance } from './api-schemas.js';

/**
 * Driver-tip bounds. Mirror the server contract in
 * apps/api/.../checkout/dto/checkout-request.dto.ts — every order is a
 * delivery and the driver tip is mandatory ($2 floor), capped at $500 to
 * stop a cents/dollars fat-finger. The server re-validates; these exist so
 * the UI never submits a value the server will reject.
 */
export const MIN_DRIVER_TIP_CENTS = 200;
export const MAX_DRIVER_TIP_CENTS = 50_000;

/** Driver-note cap — mirrors MAX_DELIVERY_INSTRUCTIONS_LENGTH on the server. */
export const MAX_DELIVERY_INSTRUCTIONS = 500;

/** Format integer cents as a USD string, e.g. 1234 → "$12.34". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
}

/** Clamp + round a dollar tip entry to a valid integer-cents value. */
export function tipDollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return MIN_DRIVER_TIP_CENTS;
  const cents = Math.round(dollars * 100);
  if (cents < MIN_DRIVER_TIP_CENTS) return MIN_DRIVER_TIP_CENTS;
  if (cents > MAX_DRIVER_TIP_CENTS) return MAX_DRIVER_TIP_CENTS;
  return cents;
}

/** Whether a tip in cents is within the accepted server range. */
export function isValidTipCents(cents: number): boolean {
  return Number.isInteger(cents) && cents >= MIN_DRIVER_TIP_CENTS && cents <= MAX_DRIVER_TIP_CENTS;
}

/** Preset tip choices (cents) offered as quick buttons. */
export const TIP_PRESETS_CENTS: readonly number[] = [300, 500, 700, 1000];

export interface ComplianceBar {
  readonly label: string;
  readonly used: number;
  readonly max: number;
  readonly unit: string;
  /** 0–100, clamped. */
  readonly percent: number;
  readonly tone: 'ok' | 'warn' | 'over';
}

function tone(percent: number): ComplianceBar['tone'] {
  if (percent >= 100) return 'over';
  if (percent >= 70) return 'warn';
  return 'ok';
}

function pct(used: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

/**
 * Project the compliance totals/limits into three render-ready progress bars
 * (flower g, concentrate g, edible THC mg). The server is authoritative on
 * pass/fail; these bars only visualise the snapshot it returned.
 */
export function complianceBars(compliance: Compliance): ComplianceBar[] {
  const { cartTotals: t, limits: l } = compliance;
  return [
    {
      label: 'Flower',
      used: t.flowerGrams,
      max: l.flowerGramsMax,
      unit: 'g',
      percent: pct(t.flowerGrams, l.flowerGramsMax),
      tone: tone(pct(t.flowerGrams, l.flowerGramsMax)),
    },
    {
      label: 'Concentrate',
      used: t.concentrateGrams,
      max: l.concentrateGramsMax,
      unit: 'g',
      percent: pct(t.concentrateGrams, l.concentrateGramsMax),
      tone: tone(pct(t.concentrateGrams, l.concentrateGramsMax)),
    },
    {
      label: 'Edible THC',
      used: t.edibleThcMg,
      max: l.edibleThcMgMax,
      unit: 'mg',
      percent: pct(t.edibleThcMg, l.edibleThcMgMax),
      tone: tone(pct(t.edibleThcMg, l.edibleThcMgMax)),
    },
  ];
}

/** Human label for a failed compliance rule id. */
export function failedRuleLabel(rule: string): string {
  const map: Record<string, string> = {
    age: 'Age verification',
    kyc: 'Identity verification',
    dispensary_license: 'Dispensary license',
    hours: 'Store hours',
    delivery_geofence: 'Delivery area',
    per_transaction_limit: 'Purchase limit',
    product_provenance: 'Product eligibility',
    evaluation: 'Compliance check',
  };
  return map[rule] ?? rule;
}

/** The deep link that returns the user to the iOS app after checkout. */
export function orderCompleteDeepLink(orderId: string): string {
  return `dankdash://order/complete?orderId=${encodeURIComponent(orderId)}`;
}
