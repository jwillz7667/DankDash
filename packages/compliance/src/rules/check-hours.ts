/**
 * Sale-hours rule — Minn. Stat. § 342.27, subd. (d).
 *
 * Thin adapter over `@dankdash/dispensaries`'s `effectiveWindowFor`. The
 * statute caps sales at 08:00–02:00 local; the shared hours engine handles
 * the cross-midnight close, DST, and state-cap intersection. This file
 * supplies the MN state cap, packages the result as a `RuleResult`, and
 * preserves the `details` payload shape that the iOS preview client
 * already reads.
 */
import {
  effectiveWindowFor,
  lookupHoursForDay,
  type EffectiveWindow,
} from '@dankdash/dispensaries';
import { DateTime } from 'luxon';
import { MN_SALES_HOURS } from '../constants.js';
import type { DayHours, EvaluationContext, RuleResult } from '../types.js';

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

  const todayHours = lookupHoursForDay(ctx.dispensary.hoursJson, startOfToday);
  const yesterdayHours = lookupHoursForDay(ctx.dispensary.hoursJson, startOfYesterday);

  const todayWindow = effectiveWindowFor(ctx.dispensary.hoursJson, startOfToday, MN_SALES_HOURS);
  const yesterdayWindow = effectiveWindowFor(
    ctx.dispensary.hoursJson,
    startOfYesterday,
    MN_SALES_HOURS,
  );

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

function inWindow(t: DateTime, window: EffectiveWindow): boolean {
  return t >= window.open && t < window.close;
}

function windowToDetails(
  window: EffectiveWindow | null,
  hours: DayHours | null,
): Record<string, unknown> {
  if (window === null) {
    return { effective: null, declared: hours };
  }
  return {
    effective: { open: window.open.toISO(), close: window.close.toISO() },
    declared: hours,
  };
}
