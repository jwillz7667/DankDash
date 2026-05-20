/**
 * Display helpers for the menu / listings surface. Pure functions only,
 * mirroring `lib/orders/format.ts`. The menu page reuses
 * `formatMoney` from there; this file adds the listings-specific
 * helpers (cents → editable string, sync-staleness tone, etc.).
 */

const MONEY_INPUT_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/**
 * Cents → "12.50" for use inside an `<input type="text">` editable
 * field. No currency symbol — the input is preceded by a "$" decoration
 * in the cell. Negative input is unreachable from a vendor edit (the
 * price column rejects values ≤ 0 at validate time) but the formatter
 * still handles it cleanly so the same helper is safe for a future
 * refund-amount field.
 */
export function formatCentsForInput(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  return MONEY_INPUT_FORMATTER.format(cents / 100);
}

/**
 * Parse the editable "12.50" string back to cents. Returns `null` when
 * the input is empty, NaN, negative, or has more than two fractional
 * digits — the caller surfaces a typed validation message at that point.
 * Accepts an optional leading "$" so paste-in from a vendor's POS UI
 * doesn't reject because of the decoration.
 *
 * We don't go through `Number.parseFloat` directly — it accepts "1.2.3"
 * as "1.2" and rounds away the trailing decimals, which would silently
 * drop the sub-cent precision the vendor was trying to set.
 */
export function parseInputToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/^\$/u, '').replace(/,/gu, '');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/u.test(trimmed)) return null;
  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber)) return null;
  if (asNumber < 0) return null;
  // Use string parsing rather than asNumber * 100 to avoid the classic
  // 0.1 + 0.2 = 0.30000000000000004 — "12.34" * 100 occasionally yields
  // 1233.9999999999998 on V8, and Math.round would mask the issue but
  // not in every edge case.
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '00').slice(0, 2);
  return Number.parseInt(whole ?? '0', 10) * 100 + Number.parseInt(padded, 10);
}

/**
 * Parse an integer quantity. Returns null on negative, fractional, or
 * non-numeric input. The vendor portal caps the editable upper bound at
 * 1,000,000 to match the server's Zod schema; values above that fall
 * through here and surface as the typed 422 the API returns.
 */
export function parseInputToQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/u.test(trimmed)) return null;
  const asNumber = Number.parseInt(trimmed, 10);
  if (asNumber < 0) return null;
  if (asNumber > 1_000_000) return null;
  return asNumber;
}

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

export type SyncStaleness = 'fresh' | 'aging' | 'stale' | 'never';

/**
 * Sync staleness tone. Mirrors the queue's `ageTone` shape so the menu
 * sync banner and the queue card draw from the same vocabulary.
 *
 *   - `fresh`   — synced in the last hour. Green dot.
 *   - `aging`   — 1–24 hours. Amber dot.
 *   - `stale`   — over 24 hours. Red dot.
 *   - `never`   — `lastSyncedAt === null`. Slate dot.
 *
 * Thresholds intentionally generous — a vendor edits inventory by hand
 * far more often than the POS sync runs, and we don't want to nag.
 */
export function syncStaleness(lastSyncedAt: string | null, now: Date = new Date()): SyncStaleness {
  if (lastSyncedAt === null) return 'never';
  const then = Date.parse(lastSyncedAt);
  if (Number.isNaN(then)) return 'never';
  const diffSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSeconds < HOUR) return 'fresh';
  if (diffSeconds < DAY) return 'aging';
  return 'stale';
}

/**
 * Friendly label for a sync timestamp — "Just synced", "Synced 4h ago",
 * "Synced May 18", or "Never synced". Used in the per-row sync indicator
 * and in the page-level banner.
 */
export function formatSyncedLabel(lastSyncedAt: string | null, now: Date = new Date()): string {
  if (lastSyncedAt === null) return 'Never synced';
  const then = Date.parse(lastSyncedAt);
  if (Number.isNaN(then)) return 'Never synced';
  const diffSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSeconds < 90) return 'Synced just now';
  if (diffSeconds < HOUR) {
    const minutes = Math.floor(diffSeconds / MINUTE);
    return `Synced ${minutes.toString()}m ago`;
  }
  if (diffSeconds < DAY) {
    const hours = Math.floor(diffSeconds / HOUR);
    return `Synced ${hours.toString()}h ago`;
  }
  if (diffSeconds < 7 * DAY) {
    const days = Math.floor(diffSeconds / DAY);
    return `Synced ${days.toString()}d ago`;
  }
  return `Synced ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    then,
  )}`;
}
