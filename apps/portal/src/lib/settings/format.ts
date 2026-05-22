/**
 * Display + edit helpers for the vendor settings surface. Pure
 * functions — verified in isolation without React.
 */
import type {
  DayHours,
  DispensaryHours,
  LicenseType,
  PosProvider,
} from '../api/vendor-settings.js';

export interface DayDef {
  readonly key: keyof DispensaryHours;
  readonly label: string;
  readonly short: string;
}

export const DAYS: readonly DayDef[] = [
  { key: 'mon', label: 'Monday', short: 'Mon' },
  { key: 'tue', label: 'Tuesday', short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' },
  { key: 'thu', label: 'Thursday', short: 'Thu' },
  { key: 'fri', label: 'Friday', short: 'Fri' },
  { key: 'sat', label: 'Saturday', short: 'Sat' },
  { key: 'sun', label: 'Sunday', short: 'Sun' },
];

const LICENSE_LABELS: Readonly<Record<LicenseType, string>> = {
  retailer: 'Retailer',
  microbusiness: 'Microbusiness',
  mezzobusiness: 'Mezzobusiness',
  medical_combo: 'Medical Combination',
  delivery_service: 'Delivery Service',
  lphe_retailer: 'Lower-Potency Hemp Edible Retailer',
};

export function licenseTypeLabel(licenseType: LicenseType): string {
  return LICENSE_LABELS[licenseType];
}

const POS_LABELS: Readonly<Record<PosProvider, string>> = {
  dutchie: 'Dutchie',
  flowhub: 'Flowhub',
  treez: 'Treez',
  greenbits: 'Greenbits',
  cova: 'Cova',
  manual: 'Manual (no POS)',
};

export function posProviderLabel(provider: PosProvider): string {
  return POS_LABELS[provider];
}

/**
 * "May 18, 2026" for a YYYY-MM-DD calendar string. UTC-rendered (the
 * source column has no time/zone) so the displayed date matches the
 * statute — license expiry is a wall-clock day, not an instant.
 */
export function formatCalendarDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

/** ISO-8601 UTC → "May 19, 2026, 1:00 PM CDT". Returns "—" for null. */
export function formatSyncTimestamp(iso: string | null): string {
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

/**
 * Days-until-expiry, rendered as a tone-flagged warning when the
 * license is inside the 90-day window the spec calls out. Returns null
 * outside the window (the green "license is current" state needs no
 * loud rendering).
 *
 * Pure function so the component just maps tone → class without
 * recomputing the math.
 */
export type ExpiryStatus = 'expired' | 'critical' | 'warn' | 'ok';

export function licenseExpiryStatus(
  licenseExpiresAt: string,
  now: Date = new Date(),
): { readonly status: ExpiryStatus; readonly daysRemaining: number } {
  const target = Date.parse(`${licenseExpiresAt}T00:00:00.000Z`);
  if (Number.isNaN(target)) return { status: 'ok', daysRemaining: Number.POSITIVE_INFINITY };
  const days = Math.floor((target - now.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 0) return { status: 'expired', daysRemaining: days };
  if (days <= 30) return { status: 'critical', daysRemaining: days };
  if (days <= 90) return { status: 'warn', daysRemaining: days };
  return { status: 'ok', daysRemaining: days };
}

/**
 * Validates an `HH:MM` string against the wire schema (00-30 hour,
 * 00-59 minute). The API does the authoritative check; this only
 * blocks the obvious bad-input cases before we hit the network.
 */
export function isValidHhMm(value: string): boolean {
  return /^([0-2]?\d|30):[0-5]\d$/u.test(value);
}

/**
 * Inflate a partial day record into a normalized DayHours, or null if
 * the day should be closed. Both `open` and `close` are required when
 * one is present.
 */
export function normalizeDay(open: string, close: string, closed: boolean): DayHours | null {
  if (closed) return null;
  return { open, close };
}

/**
 * Compare two hours schedules for equality so the autosave doesn't
 * push a no-op patch.
 */
export function hoursEqual(a: DispensaryHours, b: DispensaryHours): boolean {
  for (const def of DAYS) {
    const av = a[def.key];
    const bv = b[def.key];
    if (av === null && bv === null) continue;
    if (av === null || bv === null) return false;
    if (av.open !== bv.open || av.close !== bv.close) return false;
  }
  return true;
}
