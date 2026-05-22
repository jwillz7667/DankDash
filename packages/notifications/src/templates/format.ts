/**
 * Currency / unit formatters shared across templates. Kept in one file
 * so a copy-formatting change (e.g. "$" → "USD $") propagates to every
 * template at once and so the snapshot tests have a single source of
 * truth for "what does `$24.99` render as".
 *
 * Currency input is always integer cents — this is the codebase-wide
 * convention (CLAUDE.md "Money, IDs, and time"). Templates never see
 * raw dollar floats.
 */

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsdCents(amountCents: number): string {
  return USD_FORMATTER.format(amountCents / 100);
}

export function formatMilesShort(distanceMiles: number): string {
  // One decimal everywhere — matches the rest of the consumer surface
  // (cart distance pill, dispatch admin board, driver "x.x mi away").
  return `${distanceMiles.toFixed(1)} mi`;
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return 'less than a minute';
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}

/**
 * Single-line text snippet for an order ID — first 8 hex characters of
 * the UUIDv7, prefixed with `#`. Matches the consumer receipt format
 * and the email subject conventions. Falls back to the full ID when
 * the input is shorter than 8 chars (defensive — UUIDv7 is always 36).
 */
export function formatOrderShort(orderId: string): string {
  return `#${orderId.slice(0, 8).toUpperCase()}`;
}
