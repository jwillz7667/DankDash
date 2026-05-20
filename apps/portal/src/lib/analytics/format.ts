/**
 * Display helpers for the analytics surface. Pure functions only —
 * compact currency for tight KPI cards, percent + signed delta for the
 * trend lines under each KPI, and a heatmap-cell tone scale that maps
 * a normalized 0..1 value to a Tailwind moss tint.
 */

const COMPACT_MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const FULL_MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Cents → compact dollar string ("$2.5K", "$1.2M"). Used in stat cards
 * and chart axes where horizontal space is tight; the full value is
 * available in the chart tooltip.
 */
export function formatCompactMoney(cents: number): string {
  if (!Number.isFinite(cents)) return '$—';
  return COMPACT_MONEY.format(cents / 100);
}

/** Cents → "$X.XX". Used in dense tables (top products, dead inventory). */
export function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return '$—';
  return FULL_MONEY.format(cents / 100);
}

/**
 * 0..1 ratio → "32.2%". Returns "—" for non-finite inputs (the reorder
 * card uses this for the zero-customers fallback the API already
 * clamps to 0, but defense in depth is cheap).
 */
export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const pct = rate * 100;
  return `${pct.toFixed(pct >= 100 || Number.isInteger(pct) ? 0 : 1)}%`;
}

export type DeltaTrend = 'up' | 'down' | 'flat';

export interface DeltaSummary {
  /** Display string — "+12.5%", "−4.2%", "—", or "+$5.2K" for zero-baseline cases. */
  readonly label: string;
  readonly trend: DeltaTrend;
}

/**
 * Compute the period-over-period delta for a metric where higher is
 * better. The previous-period number lands as a separate field on the
 * API response so we can render "—" when the baseline is zero (the
 * percent would be Infinity), and a signed absolute-value fallback so
 * the operator still sees direction even when the baseline is small.
 */
export function deltaForBigger(current: number, previous: number): DeltaSummary {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { label: '—', trend: 'flat' };
  }
  if (previous === 0) {
    if (current === 0) return { label: '—', trend: 'flat' };
    return { label: 'new', trend: 'up' };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 0.5) return { label: 'flat vs prior', trend: 'flat' };
  const sign = pct > 0 ? '+' : '−';
  return {
    label: `${sign}${Math.abs(pct).toFixed(1)}% vs prior`,
    trend: pct > 0 ? 'up' : 'down',
  };
}

/**
 * Heatmap intensity classes. Five steps of moss with a slate fallback
 * for empty cells — matches the moss palette used elsewhere in the
 * portal so it sits within the brand. `null` means "no orders" and
 * renders flat slate.
 */
const HEAT_STEPS = [
  'bg-slate-100 text-slate-400',
  'bg-moss-100 text-moss-800',
  'bg-moss-200 text-moss-900',
  'bg-moss-300 text-moss-900',
  'bg-moss-400 text-white',
  'bg-moss-500 text-white',
] as const;

export function heatmapClass(normalized: number | null): string {
  if (normalized === null || !Number.isFinite(normalized)) return HEAT_STEPS[0];
  if (normalized <= 0) return HEAT_STEPS[0];
  if (normalized < 0.2) return HEAT_STEPS[1];
  if (normalized < 0.4) return HEAT_STEPS[2];
  if (normalized < 0.6) return HEAT_STEPS[3];
  if (normalized < 0.85) return HEAT_STEPS[4];
  return HEAT_STEPS[5];
}

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function dayOfWeekLabel(dow: number): string {
  if (dow < 0 || dow > 6) return '';
  return DAY_LABEL[dow as 0 | 1 | 2 | 3 | 4 | 5 | 6];
}

/** "13:00" — 24h to keep the heatmap headers a constant 2-char width. */
export function hourLabel(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`;
}

/**
 * ISO timestamp → "May 13" / "May 13 2025" when the year differs from
 * the current one. Used in the "window" subline under the KPIs.
 */
export function formatWindowLabel(from: string, to: string, now: Date = new Date()): string {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  // `to` is exclusive; render the inclusive end (subtract 1ms).
  const inclusiveTo = new Date(toDate.getTime() - 1);
  const sameYear = fromDate.getUTCFullYear() === inclusiveTo.getUTCFullYear();
  const sameAsCurrentYear = inclusiveTo.getUTCFullYear() === now.getUTCFullYear();
  const fromFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
  const toFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameAsCurrentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
  return `${fromFmt.format(fromDate)} – ${toFmt.format(inclusiveTo)}`;
}

/**
 * "X days ago" / "today" — used in the dead inventory table to make
 * the days-since-last-sale column scannable without forcing the
 * operator to compare against the window's end.
 */
export function formatDaysSinceLastSale(days: number | null): string {
  if (days === null) return 'Never';
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days.toString()} days ago`;
}
