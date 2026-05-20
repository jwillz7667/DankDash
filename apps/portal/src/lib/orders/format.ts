/**
 * Display helpers for the order queue. Pure functions only — every
 * input is a primitive or `Date`, every output is a string. No locale
 * detection (the portal is single-locale en-US for v1), no `Intl.*`
 * caches (the formatters are cheap enough to construct per call and
 * V8 caches them under the hood).
 */

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Cents → "$X.XX". Negative values (e.g. refund display) get a leading
 * "−", not the locale-default parenthesized form, so they read
 * uniformly with positive totals in dense tables.
 */
export function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return '$—';
  return MONEY_FORMATTER.format(cents / 100);
}

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

/**
 * ISO timestamp → "just now" / "Xm ago" / "Xh Ym ago" / "MMM D" for
 * older entries. Compact and time-zone agnostic — the absolute time is
 * available on hover via the parent component's `title` attribute, so
 * the queue card stays scannable.
 *
 * `now` is injectable for deterministic tests; production callers use
 * the default `new Date()`.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diffSeconds = Math.max(0, Math.round((now.getTime() - then) / 1000));

  if (diffSeconds < 30) return 'just now';
  if (diffSeconds < MINUTE) return `${diffSeconds.toString()}s ago`;
  if (diffSeconds < HOUR) {
    const minutes = Math.floor(diffSeconds / MINUTE);
    return `${minutes.toString()}m ago`;
  }
  if (diffSeconds < DAY) {
    const hours = Math.floor(diffSeconds / HOUR);
    const minutes = Math.floor((diffSeconds % HOUR) / MINUTE);
    return minutes > 0
      ? `${hours.toString()}h ${minutes.toString()}m ago`
      : `${hours.toString()}h ago`;
  }
  // ≥ 1 day stays in the queue only by accident (the API filter is
  // active statuses); render an absolute date so the operator notices
  // the staleness and digs in.
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(then);
}

/**
 * Order short-code → "#ABCD". The wire shape is just the letters; the
 * "#" is purely presentational so consumers don't have to repeat the
 * prefix at every call site.
 */
export function formatShortCode(shortCode: string): string {
  return `#${shortCode}`;
}
