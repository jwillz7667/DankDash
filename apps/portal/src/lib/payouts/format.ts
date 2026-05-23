/**
 * Display helpers for the payouts surface. Pure functions only — the
 * pages render server-side and the unit tests verify these in isolation
 * without React or Next runtime.
 */
import type { VendorPayoutStatus } from '../api/vendor-payouts.js';

/**
 * "May 17, 2026" — accepts a `date` column string (YYYY-MM-DD). Renders
 * in UTC because the date column has no time/zone; treating it as
 * America/Chicago at 00:00 and then re-formatting in zone would only
 * matter near the DST boundary and add a luxon dependency to a server
 * component for no visible win.
 */
export function formatPeriodDate(date: string): string {
  const parsed = parseIsoDate(date);
  if (parsed === null) return date;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/**
 * "May 17, 2026" → for a single-day period (periodEnd is exclusive and
 * differs from periodStart by one day) the portal still wants to show
 * the operator the inclusive day. For multi-day periods, render an
 * "X – Y" range with the inclusive upper bound.
 *
 * Payout periods are typically single-day (the daily-payout job runs
 * each Central calendar day) — but the API accepts arbitrary windows so
 * the helper handles both cases.
 */
export function formatPeriodRange(periodStart: string, periodEnd: string): string {
  const startDate = parseIsoDate(periodStart);
  const endDate = parseIsoDate(periodEnd);
  if (startDate === null || endDate === null) return `${periodStart} – ${periodEnd}`;
  const inclusiveEnd = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
  const sameDay = startDate.getTime() === inclusiveEnd.getTime();
  if (sameDay) return formatPeriodDate(periodStart);
  return `${formatPeriodDate(periodStart)} – ${formatLocalDate(inclusiveEnd)}`;
}

/**
 * ISO-8601 UTC timestamp → "May 18, 2026, 3:15 AM CDT" rendered in
 * America/Chicago so the operator reads it in their store's local
 * calendar. Returns "—" for null.
 */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
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

export interface StatusBadgeProps {
  readonly label: string;
  /** Tailwind class string for the badge background + text color. */
  readonly className: string;
}

const STATUS_LABELS: Readonly<Record<VendorPayoutStatus, string>> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Paid',
  failed: 'Failed',
  canceled: 'Canceled',
};

const STATUS_CLASSES: Readonly<Record<VendorPayoutStatus, string>> = {
  pending: 'bg-surface-subtle text-secondary ring-outline',
  processing: 'bg-warning-soft text-warning ring-warning/30',
  completed: 'bg-moss-100 text-moss-800 ring-moss-200',
  failed: 'bg-danger-soft text-danger ring-danger/30',
  canceled: 'bg-surface-subtle text-muted ring-outline',
};

export function payoutStatusBadge(status: VendorPayoutStatus): StatusBadgeProps {
  return {
    label: STATUS_LABELS[status],
    className: STATUS_CLASSES[status],
  };
}

/**
 * Format a customer's display name from the first/last fields the API
 * surfaces. Privacy-respecting variant — "Jane D." rather than the full
 * surname, matching the queue card convention. Null/empty surnames fall
 * back to the first name alone, then to "Customer" as a last resort.
 */
export function formatCustomerShortName(firstName: string | null, lastName: string | null): string {
  const first = firstName?.trim() ?? '';
  const last = lastName?.trim() ?? '';
  if (first === '' && last === '') return 'Customer';
  if (last === '') return first;
  const initial = last.charAt(0);
  if (first === '') return `${initial}.`;
  return `${first} ${initial}.`;
}

function parseIsoDate(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function formatLocalDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
