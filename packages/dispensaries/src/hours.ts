/**
 * Hours-of-operation arithmetic for dispensaries.
 *
 * This module is the single source of truth for "is this dispensary open at
 * instant X?" — used by:
 *   - the compliance engine (sale-hours rule, Minn. Stat. § 342.27, subd. (d))
 *   - the listings/menu surface (mark items unavailable when closed)
 *   - search ranking (demote dispensaries that are currently closed)
 *
 * Two subtleties drive the implementation:
 *
 *   1. Cross-midnight close. A dispensary open 09:00–02:00 has a window that
 *      spills into the next calendar day. The user's `localNow` may therefore
 *      fall inside YESTERDAY's window rather than today's (a Tuesday 1:30 AM
 *      query is in Monday's 09:00–02:00 window, not Tuesday's). We build both
 *      windows and pass if `localNow` lies in either.
 *
 *   2. DST. Spring-forward and fall-back are handled by luxon: day arithmetic
 *      uses `.plus({days: 1})` (DST-aware) and time-of-day anchoring uses
 *      `.set({hour, minute})` (skips/duplicates per the transition). The
 *      compliance tests lock down behaviour at the America/Chicago transitions.
 *
 * Close-time encoding: `HH:MM` 24-hour. Hours > 24 denote a next-day close
 * (e.g. `26:00` is 2:00 AM the following day). Alternatively, a close that is
 * numerically less than open is interpreted as next-day —
 * `{ open: "09:00", close: "02:00" }` is equivalent to
 * `{ open: "09:00", close: "26:00" }`.
 *
 * Optional `StateSalesCap` argument intersects the dispensary's window with
 * a statutory cap. MN passes `{ earliestOpen: 08:00, latestClose: 26:00 }`;
 * other jurisdictions (or callers that only want operational hours, e.g. a
 * "hours today" card with no compliance overlay) omit the cap.
 */
import { DateTime } from 'luxon';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 3-letter lowercase weekday keys. Stored as a closed union so a
 * `Record<Weekday, ...>` is exhaustive without an index signature.
 * Matches the format luxon produces via
 * `DateTime.weekdayLong.slice(0, 3).toLowerCase()`.
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * Open/close pair for a single day in the dispensary's local time.
 * Format: `HH:MM` 24-hour. A close time may exceed 24:00 (e.g. `26:00`)
 * to denote a next-day close. Malformed values cause `effectiveWindowFor`
 * to return `null` — never throw — so the caller can fail closed.
 */
export interface DayHours {
  readonly open: string;
  readonly close: string;
}

/** Full weekly schedule. `null` for any day the dispensary is closed. */
export type DispensaryHours = Readonly<Record<Weekday, DayHours | null>>;

export interface HourMinute {
  readonly hour: number;
  readonly minute: number;
}

/**
 * Statutory cap intersected into the effective window. Half-open interval
 * `[earliestOpen, latestClose)` — a sale exactly at `latestClose` is rejected.
 * `latestClose.hour` may be ≥ 24 to denote a next-day close (MN uses 26:00).
 */
export interface StateSalesCap {
  readonly earliestOpen: HourMinute;
  readonly latestClose: HourMinute;
}

/**
 * Effective sales window for a single day, with both endpoints already
 * anchored to the dispensary's local zone. Half-open interval
 * `[open, close)`. Returned by `effectiveWindowFor`; consumed by the
 * compliance rule's `details` payload.
 */
export interface EffectiveWindow {
  readonly open: DateTime;
  readonly close: DateTime;
}

// ---------------------------------------------------------------------------
// Internal: weekday mapping
// ---------------------------------------------------------------------------

const WEEKDAY_BY_LUXON: Readonly<Record<number, Weekday>> = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

/** Look up the declared hours for the day starting at `dayStart`. */
export function lookupHoursForDay(hours: DispensaryHours, dayStart: DateTime): DayHours | null {
  const weekday = WEEKDAY_BY_LUXON[dayStart.weekday];
  /* c8 ignore next -- luxon `weekday` is always 1..7; only noUncheckedIndexedAccess demands this */
  if (weekday === undefined) return null;
  return hours[weekday];
}

// ---------------------------------------------------------------------------
// parseHourMinute
// ---------------------------------------------------------------------------

const HHMM_REGEX = /^(\d{1,2}):(\d{2})$/;

/**
 * Defensive `HH:MM` parser. Accepts hours 0..30 (to support next-day close
 * encoding up to 06:00 next day) and minutes 0..59. Returns `null` for any
 * other input — the caller is expected to fail closed on a `null`.
 */
export function parseHourMinute(value: string): HourMinute | null {
  const match = HHMM_REGEX.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  /* c8 ignore next -- regex `\d{1,2}:\d{2}` only matches digit strings; Number() always yields integers here */
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 30) return null;
  if (minute < 0 || minute >= 60) return null;
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// effectiveWindowFor
// ---------------------------------------------------------------------------

/**
 * Build the effective sales window for a given calendar day, optionally
 * intersected with a state cap. Returns `null` if:
 *   - hours for the day are missing (`null` in the schedule),
 *   - the open or close string is malformed,
 *   - the cap renders the window empty (e.g. a dispensary that declares
 *     03:00–07:00 — entirely within MN's prohibited 02:00–08:00 band).
 *
 * `dayStart` must be a `DateTime` already anchored to the dispensary's
 * local zone via `DateTime.fromObject(..., { zone })` and reduced to the
 * day boundary via `.startOf('day')`.
 */
export function effectiveWindowFor(
  hours: DispensaryHours,
  dayStart: DateTime,
  stateCap?: StateSalesCap,
): EffectiveWindow | null {
  const day = lookupHoursForDay(hours, dayStart);
  if (day === null) return null;

  const open = parseHourMinute(day.open);
  const close = parseHourMinute(day.close);
  if (open === null || close === null) return null;

  const openMinutes = open.hour * 60 + open.minute;
  let closeMinutes = close.hour * 60 + close.minute;
  // Cross-midnight encoding: `09:00–02:00` means close on the next calendar
  // day. Equivalent to `09:00–26:00`.
  if (closeMinutes <= openMinutes) closeMinutes += 24 * 60;

  const openAt = anchorAt(dayStart, openMinutes);
  const closeAt = anchorAt(dayStart, closeMinutes);
  /* c8 ignore next -- parseHourMinute clamps to hour 0..30 / minute 0..59; luxon set() never returns invalid for these */
  if (!openAt.isValid || !closeAt.isValid) return null;

  if (stateCap === undefined) return { open: openAt, close: closeAt };

  const stateEarliest = anchorAt(
    dayStart,
    stateCap.earliestOpen.hour * 60 + stateCap.earliestOpen.minute,
  );
  const stateLatest = anchorAt(
    dayStart,
    stateCap.latestClose.hour * 60 + stateCap.latestClose.minute,
  );

  const effectiveOpen = openAt < stateEarliest ? stateEarliest : openAt;
  const effectiveClose = closeAt > stateLatest ? stateLatest : closeAt;
  if (effectiveOpen >= effectiveClose) return null;

  return { open: effectiveOpen, close: effectiveClose };
}

/**
 * Anchor a wall-clock time at `minutes` after the start of `dayStart`.
 *
 * For minutes representing hour < 24, uses `.set({hour, minute})` so the
 * result lands on the wall clock regardless of DST. For minutes representing
 * hour >= 24, advances by one calendar day (DST-aware) and sets the
 * remaining hour/minute. Invalid wall clocks (e.g. 2:30 AM on spring-forward
 * day) propagate as `isValid === false`, which `effectiveWindowFor` treats
 * as a missing window — fail closed.
 */
function anchorAt(dayStart: DateTime, totalMinutes: number): DateTime {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  if (hour < 24) {
    return dayStart.set({ hour, minute, second: 0, millisecond: 0 });
  }
  return dayStart.plus({ days: 1 }).set({ hour: hour - 24, minute, second: 0, millisecond: 0 });
}

// ---------------------------------------------------------------------------
// isOpenAt — instant-level public API
// ---------------------------------------------------------------------------

/**
 * Is the dispensary open at instant `at`? Returns `false` for an invalid
 * timezone — the caller is expected to fail closed.
 *
 * Checks both today's and yesterday's effective windows to handle a
 * cross-midnight close encoded for the prior day.
 */
export function isOpenAt(
  hours: DispensaryHours,
  at: Date,
  timezone: string,
  stateCap?: StateSalesCap,
): boolean {
  const localNow = DateTime.fromJSDate(at, { zone: timezone });
  if (!localNow.isValid) return false;

  const startOfToday = localNow.startOf('day');
  const startOfYesterday = startOfToday.minus({ days: 1 });

  const todayWindow = effectiveWindowFor(hours, startOfToday, stateCap);
  const yesterdayWindow = effectiveWindowFor(hours, startOfYesterday, stateCap);

  const inToday = todayWindow !== null && inWindow(localNow, todayWindow);
  const inYesterday = yesterdayWindow !== null && inWindow(localNow, yesterdayWindow);
  return inToday || inYesterday;
}

function inWindow(t: DateTime, window: EffectiveWindow): boolean {
  return t >= window.open && t < window.close;
}

// ---------------------------------------------------------------------------
// nextOpenAt — forward search for "opens in N min" UI
// ---------------------------------------------------------------------------

const NEXT_OPEN_HORIZON_DAYS = 14;

/**
 * Returns the next instant `>= at` when the dispensary is open, or `null`
 * if it doesn't open within `NEXT_OPEN_HORIZON_DAYS` (14). When currently
 * open, returns `at` itself.
 *
 * Walks day-by-day from yesterday (to catch a cross-midnight window already
 * in progress) through `at + 14 days`. The horizon bounds worst-case work
 * to a small constant — a dispensary truly closed for two weeks is treated
 * as "not opening" for UI purposes.
 */
export function nextOpenAt(
  hours: DispensaryHours,
  at: Date,
  timezone: string,
  stateCap?: StateSalesCap,
): Date | null {
  const localAt = DateTime.fromJSDate(at, { zone: timezone });
  if (!localAt.isValid) return null;

  const startOfToday = localAt.startOf('day');

  // Walk yesterday → today → ... → today+14. Yesterday catches a still-open
  // cross-midnight window (e.g. it's 1:30 AM Tue and Mon's window runs to 2 AM).
  for (let offset = -1; offset <= NEXT_OPEN_HORIZON_DAYS; offset++) {
    const dayStart = startOfToday.plus({ days: offset });
    const window = effectiveWindowFor(hours, dayStart, stateCap);
    if (window === null) continue;
    if (window.close <= localAt) continue;
    const openAt = window.open > localAt ? window.open : localAt;
    return openAt.toJSDate();
  }

  return null;
}
