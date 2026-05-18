/**
 * Sale-hours rule — Minn. Stat. § 342.27, subd. (d).
 *
 * The state forbids sales between 2:00 AM and 8:00 AM local time. Each
 * dispensary may declare its own narrower hours via `hoursJson`; the
 * effective window is the intersection (state cap AND dispensary hours).
 *
 * Two subtleties drive the implementation:
 *
 *   1. Cross-midnight close. A dispensary open 09:00–02:00 has a window
 *      that spills into the next calendar day. The user's `localNow`
 *      may therefore fall inside YESTERDAY's window rather than today's
 *      (e.g. a Tuesday 1:30 AM query is in Monday's 09:00–02:00 window,
 *      not Tuesday's). We build both windows and pass if `localNow` lies
 *      in either.
 *
 *   2. DST. Spring-forward and fall-back are handled by luxon: day
 *      arithmetic uses `.plus({days: 1})` (DST-aware) and time-of-day
 *      anchoring uses `.set({hour, minute})` (skips/duplicates per the
 *      transition). The test suite locks down the behaviour at the
 *      America/Chicago transitions.
 *
 * Close-time encoding: `HH:MM` 24-hour. Hours > 24 denote a next-day
 * close (e.g. `26:00` is 2:00 AM the following day). Alternatively, a
 * close that is numerically less than open is interpreted as next-day —
 * `{ open: "09:00", close: "02:00" }` is equivalent to
 * `{ open: "09:00", close: "26:00" }`.
 */
import { DateTime } from 'luxon';
import { MN_SALES_HOURS } from '../constants.js';
import type { DayHours, EvaluationContext, RuleResult, Weekday } from '../types.js';

const WEEKDAY_BY_LUXON: Readonly<Record<number, Weekday>> = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

interface Window {
  readonly open: DateTime;
  readonly close: DateTime;
}

export function checkHours(ctx: EvaluationContext, now: Date): RuleResult {
  const zone = ctx.dispensary.timezone;
  const localNow = DateTime.fromJSDate(now, { zone });
  if (!localNow.isValid) {
    return {
      rule: 'hours',
      passed: false,
      details: { reason: 'invalid_timezone', timezone: zone },
    };
  }

  const startOfToday = localNow.startOf('day');
  const startOfYesterday = startOfToday.minus({ days: 1 });

  const todayHours = lookupHours(ctx, startOfToday);
  const yesterdayHours = lookupHours(ctx, startOfYesterday);

  const todayWindow = buildEffectiveWindow(startOfToday, todayHours);
  const yesterdayWindow = buildEffectiveWindow(startOfYesterday, yesterdayHours);

  const inToday = todayWindow !== null && inWindow(localNow, todayWindow);
  const inYesterday = yesterdayWindow !== null && inWindow(localNow, yesterdayWindow);
  const passed = inToday || inYesterday;

  return {
    rule: 'hours',
    passed,
    details: {
      localNow: localNow.toISO(),
      timezone: zone,
      todayWindow: windowToDetails(todayWindow, todayHours),
      yesterdayWindow: windowToDetails(yesterdayWindow, yesterdayHours),
    },
  };
}

function lookupHours(ctx: EvaluationContext, dayStart: DateTime): DayHours | null {
  const weekday = WEEKDAY_BY_LUXON[dayStart.weekday];
  if (weekday === undefined) return null;
  return ctx.dispensary.hoursJson[weekday];
}

/**
 * Build the effective sales window for a given day, intersected with the
 * state cap. Returns null if hours are missing, malformed, or fully
 * outside the cap (e.g. a dispensary that declares 03:00–07:00 — entirely
 * within the prohibited window).
 */
function buildEffectiveWindow(dayStart: DateTime, hours: DayHours | null): Window | null {
  if (hours === null) return null;
  const open = parseHourMinute(hours.open);
  const close = parseHourMinute(hours.close);
  if (open === null || close === null) return null;

  const openMinutes = open.hour * 60 + open.minute;
  let closeMinutes = close.hour * 60 + close.minute;
  if (closeMinutes <= openMinutes) closeMinutes += 24 * 60;

  const openAt = anchorAt(dayStart, openMinutes);
  const closeAt = anchorAt(dayStart, closeMinutes);
  if (!openAt.isValid || !closeAt.isValid) return null;

  const stateEarliest = anchorAt(
    dayStart,
    MN_SALES_HOURS.earliestOpen.hour * 60 + MN_SALES_HOURS.earliestOpen.minute,
  );
  const stateLatest = anchorAt(
    dayStart,
    MN_SALES_HOURS.latestClose.hour * 60 + MN_SALES_HOURS.latestClose.minute,
  );

  const effectiveOpen = openAt < stateEarliest ? stateEarliest : openAt;
  const effectiveClose = closeAt > stateLatest ? stateLatest : closeAt;
  if (effectiveOpen >= effectiveClose) return null;

  return { open: effectiveOpen, close: effectiveClose };
}

/**
 * Anchor a wall-clock time at `minutes` after the start of `dayStart`.
 * For minutes representing hour < 24, uses `.set({hour, minute})` so the
 * result lands on the wall clock regardless of DST. For minutes representing
 * hour >= 24, advances by one calendar day (DST-aware) and sets the
 * remaining hour/minute. Invalid wall clocks (e.g. 2:30 AM on spring-forward
 * day) propagate as `isValid === false`, which `buildEffectiveWindow`
 * treats as a missing window — fail closed.
 */
function anchorAt(dayStart: DateTime, totalMinutes: number): DateTime {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  if (hour < 24) {
    return dayStart.set({ hour, minute, second: 0, millisecond: 0 });
  }
  return dayStart.plus({ days: 1 }).set({ hour: hour - 24, minute, second: 0, millisecond: 0 });
}

function inWindow(t: DateTime, window: Window): boolean {
  return t >= window.open && t < window.close;
}

function parseHourMinute(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 30) return null;
  if (minute < 0 || minute >= 60) return null;
  return { hour, minute };
}

function windowToDetails(window: Window | null, hours: DayHours | null): Record<string, unknown> {
  if (window === null) {
    return { effective: null, declared: hours };
  }
  return {
    effective: { open: window.open.toISO(), close: window.close.toISO() },
    declared: hours,
  };
}
