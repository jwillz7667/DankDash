/**
 * Display + edit helpers for the vendor promotions surface. Pure
 * functions only — verified in isolation without React or Next runtime.
 *
 * Money helpers reuse `formatMoney` (cents → "$X.XX") and the listings
 * cents parser rather than re-deriving the float-safe conversion; the
 * promo-specific logic here is the polymorphic `value` rendering and the
 * datetime-local ⇄ ISO bridge the create form needs.
 */
import { formatMoney } from '../analytics/format.js';
import type { PromoType, VendorPromotion } from '../api/vendor-promotions.js';

const PROMO_TYPE_LABELS: Readonly<Record<PromoType, string>> = {
  percent: 'Percent off',
  fixed_amount: 'Amount off',
  free_delivery: 'Free delivery',
};

export function promoTypeLabel(type: PromoType): string {
  return PROMO_TYPE_LABELS[type];
}

/**
 * Human-readable value for a promo, keyed off its `type`:
 *   - percent        → "10% off"
 *   - fixed_amount   → "$5.00 off" (value is cents)
 *   - free_delivery  → "Free delivery"
 */
export function formatPromoValue(promo: Pick<VendorPromotion, 'type' | 'value'>): string {
  switch (promo.type) {
    case 'percent':
      return `${String(promo.value)}% off`;
    case 'fixed_amount':
      return `${formatMoney(promo.value)} off`;
    case 'free_delivery':
      return 'Free delivery';
  }
}

/** Min subtotal gate — "$25.00" or "None" when there is no floor. */
export function formatMinSubtotal(cents: number): string {
  if (cents <= 0) return 'None';
  return formatMoney(cents);
}

/** "12 / 100" or "12 / ∞" when the global cap is unlimited. */
export function formatRedemptions(used: number, cap: number | null): string {
  return `${String(used)} / ${cap === null ? '∞' : String(cap)}`;
}

/**
 * ISO-8601 UTC timestamp → "May 18, 2026, 3:15 AM CDT" rendered in
 * America/Chicago so the operator reads it in their store's local
 * calendar. Mirrors the payouts/settings timestamp helpers.
 */
export function formatPromoDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  }).format(date);
}

/** Active window — "starts → ends", with "No end" for an open-ended promo. */
export function formatPromoWindow(startsAt: string, endsAt: string | null): string {
  return `${formatPromoDateTime(startsAt)} → ${endsAt === null ? 'No end' : formatPromoDateTime(endsAt)}`;
}

const PROMO_CODE_RE = /^[A-Z0-9-]{3,40}$/u;

/** Uppercase + trim a raw code entry to the wire shape (charset validated separately). */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True when `code` is 3..40 chars of `[A-Z0-9-]` (matches the server Zod rule). */
export function isValidPromoCode(code: string): boolean {
  return PROMO_CODE_RE.test(code);
}

/**
 * Parse a whole percent in 1..100. Returns null on empty, non-integer,
 * or out-of-range input — the caller surfaces a typed validation message.
 */
export function parsePercent(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > 100) return null;
  return value;
}

/**
 * Parse an optional non-negative whole number (redemption caps). Returns
 * `null` for empty input (caller treats that as "unlimited"/default) and
 * `undefined` for malformed input so the two cases stay distinguishable.
 */
export function parseOptionalWholeNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

/** Pad a number to two digits for datetime-local string assembly. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Date → `YYYY-MM-DDTHH:MM` in the browser's local zone, the value shape
 * an `<input type="datetime-local">` expects. Used to seed the "starts"
 * field with "now" when authoring a new promo.
 */
export function toDatetimeLocalValue(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

/**
 * `datetime-local` value (local wall-clock, no zone) → ISO-8601 UTC.
 * `Date.parse` reads an offset-less date-time as local time per ECMAScript,
 * so this correctly folds the operator's zone into the UTC instant the API
 * stores. Returns null for empty/malformed input.
 */
export function datetimeLocalToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
