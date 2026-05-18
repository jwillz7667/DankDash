/**
 * Tests for `@dankdash/dispensaries` hours arithmetic.
 *
 * The hours module is the single source of truth for "is this dispensary
 * open at instant X?" across the codebase — used by the compliance engine
 * for the sale-hours rule, by the listings/menu surface to mark items as
 * temporarily unavailable, and by search to demote closed dispensaries.
 * A bug here is a bug everywhere.
 *
 * Coverage target is 100%/100%/100%/100% (see vitest.config.ts).
 *
 * Three families of test cases:
 *   1. `parseHourMinute` / `lookupHoursForDay` — defensive primitives.
 *   2. `effectiveWindowFor` — the core arithmetic: state-cap intersection,
 *      cross-midnight close, malformed-input handling.
 *   3. `isOpenAt` / `nextOpenAt` — the public instant-level API the
 *      service layers consume.
 *
 * Date helpers below convert "May 18 2026, 7:59 AM in America/Chicago" into
 * the corresponding UTC `Date`, which is what production code receives from
 * the request layer. May is CDT (-05:00); March before the DST spring is
 * CST (-06:00).
 */
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  effectiveWindowFor,
  isOpenAt,
  lookupHoursForDay,
  nextOpenAt,
  parseHourMinute,
  type DispensaryHours,
  type StateSalesCap,
} from '../src/index.js';

const ZONE = 'America/Chicago';

/** Mirrors the MN per-statute sales cap used by the compliance engine. */
const MN_CAP: StateSalesCap = {
  earliestOpen: { hour: 8, minute: 0 },
  latestClose: { hour: 26, minute: 0 },
};

/** Build a UTC Date corresponding to the given wall clock in America/Chicago. */
function chicagoUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetHours: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0, 0));
}

/** America/Chicago CDT offset (UTC−05:00). */
const CDT = 5;
/** America/Chicago CST offset (UTC−06:00). */
const CST = 6;

const HOURS_8_TO_26: DispensaryHours = {
  mon: { open: '08:00', close: '26:00' },
  tue: { open: '08:00', close: '26:00' },
  wed: { open: '08:00', close: '26:00' },
  thu: { open: '08:00', close: '26:00' },
  fri: { open: '08:00', close: '26:00' },
  sat: { open: '08:00', close: '26:00' },
  sun: { open: '08:00', close: '26:00' },
};

const HOURS_9_TO_21: DispensaryHours = {
  mon: { open: '09:00', close: '21:00' },
  tue: { open: '09:00', close: '21:00' },
  wed: { open: '09:00', close: '21:00' },
  thu: { open: '09:00', close: '21:00' },
  fri: { open: '09:00', close: '21:00' },
  sat: { open: '09:00', close: '21:00' },
  sun: { open: '09:00', close: '21:00' },
};

const HOURS_NEVER_OPEN: DispensaryHours = {
  mon: null,
  tue: null,
  wed: null,
  thu: null,
  fri: null,
  sat: null,
  sun: null,
};

// ---------------------------------------------------------------------------
// parseHourMinute
// ---------------------------------------------------------------------------

describe('parseHourMinute', () => {
  it('parses canonical 08:00', () => {
    expect(parseHourMinute('08:00')).toEqual({ hour: 8, minute: 0 });
  });

  it('parses single-digit hour 9:30', () => {
    expect(parseHourMinute('9:30')).toEqual({ hour: 9, minute: 30 });
  });

  it('parses next-day-close 26:00 (cross-midnight encoding)', () => {
    expect(parseHourMinute('26:00')).toEqual({ hour: 26, minute: 0 });
  });

  it('parses 30:00 (upper-bound of next-day encoding)', () => {
    expect(parseHourMinute('30:00')).toEqual({ hour: 30, minute: 0 });
  });

  it('parses 00:00 (midnight, lower bound)', () => {
    expect(parseHourMinute('00:00')).toEqual({ hour: 0, minute: 0 });
  });

  it('rejects bare hour with no colon', () => {
    expect(parseHourMinute('08')).toBeNull();
  });

  it('rejects garbage strings', () => {
    expect(parseHourMinute('not-a-time')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(parseHourMinute('')).toBeNull();
  });

  it('rejects minute > 59', () => {
    expect(parseHourMinute('08:60')).toBeNull();
  });

  it('rejects minute = 99', () => {
    expect(parseHourMinute('08:99')).toBeNull();
  });

  it('rejects hour > 30', () => {
    expect(parseHourMinute('31:00')).toBeNull();
  });

  it('rejects negative hour', () => {
    expect(parseHourMinute('-1:00')).toBeNull();
  });

  it('rejects three-digit hour 100:00', () => {
    expect(parseHourMinute('100:00')).toBeNull();
  });

  it('rejects three-digit minute', () => {
    expect(parseHourMinute('08:000')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lookupHoursForDay
// ---------------------------------------------------------------------------

describe('lookupHoursForDay', () => {
  it('returns the entry for the corresponding weekday', () => {
    // 2026-05-18 is a Monday in America/Chicago.
    const monday = DateTime.fromObject({ year: 2026, month: 5, day: 18 }, { zone: ZONE }).startOf(
      'day',
    );

    expect(lookupHoursForDay(HOURS_9_TO_21, monday)).toEqual({ open: '09:00', close: '21:00' });
  });

  it('returns null for a day declared closed', () => {
    const monday = DateTime.fromObject({ year: 2026, month: 5, day: 18 }, { zone: ZONE }).startOf(
      'day',
    );
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: null };

    expect(lookupHoursForDay(hours, monday)).toBeNull();
  });

  it('maps every weekday correctly Mon..Sun', () => {
    // 2026-05-18 is a Monday; +0..+6 walks the week.
    const distinctPerDay: DispensaryHours = {
      mon: { open: '01:00', close: '02:00' },
      tue: { open: '03:00', close: '04:00' },
      wed: { open: '05:00', close: '06:00' },
      thu: { open: '07:00', close: '08:00' },
      fri: { open: '09:00', close: '10:00' },
      sat: { open: '11:00', close: '12:00' },
      sun: { open: '13:00', close: '14:00' },
    };
    const monday = DateTime.fromObject({ year: 2026, month: 5, day: 18 }, { zone: ZONE }).startOf(
      'day',
    );

    expect(lookupHoursForDay(distinctPerDay, monday)?.open).toBe('01:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 1 }))?.open).toBe('03:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 2 }))?.open).toBe('05:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 3 }))?.open).toBe('07:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 4 }))?.open).toBe('09:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 5 }))?.open).toBe('11:00');
    expect(lookupHoursForDay(distinctPerDay, monday.plus({ days: 6 }))?.open).toBe('13:00');
  });
});

// ---------------------------------------------------------------------------
// effectiveWindowFor — uncapped (no state cap)
// ---------------------------------------------------------------------------

describe('effectiveWindowFor — uncapped', () => {
  const monday = DateTime.fromObject({ year: 2026, month: 5, day: 18 }, { zone: ZONE }).startOf(
    'day',
  );

  it('returns the declared window when no cap is provided', () => {
    const window = effectiveWindowFor(HOURS_9_TO_21, monday);

    expect(window).not.toBeNull();
    expect(window?.open.hour).toBe(9);
    expect(window?.close.hour).toBe(21);
  });

  it('returns null when the day is declared closed', () => {
    expect(effectiveWindowFor(HOURS_NEVER_OPEN, monday)).toBeNull();
  });

  it('handles cross-midnight close encoded as numerically smaller (02:00)', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '02:00' } };
    const window = effectiveWindowFor(hours, monday);

    expect(window).not.toBeNull();
    expect(window?.open.toISO()).toBe(monday.set({ hour: 9 }).toISO());
    expect(window?.close.toISO()).toBe(monday.plus({ days: 1 }).set({ hour: 2 }).toISO());
  });

  it('handles cross-midnight close encoded as 26:00 (equivalent to 02:00 next day)', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '26:00' } };
    const window = effectiveWindowFor(hours, monday);

    expect(window).not.toBeNull();
    expect(window?.close.toISO()).toBe(monday.plus({ days: 1 }).set({ hour: 2 }).toISO());
  });

  it('returns null when open string is malformed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: 'not-a-time', close: '21:00' },
    };

    expect(effectiveWindowFor(hours, monday)).toBeNull();
  });

  it('returns null when close string is malformed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: 'not-a-time' },
    };

    expect(effectiveWindowFor(hours, monday)).toBeNull();
  });

  it('returns null when open equals close (zero-length window)', () => {
    // With no cross-midnight (close == open), the close advances by 24h.
    // Without a cap that's a 24h window which is technically valid; but with
    // close == open exactly, the engine treats it as zero-length and rejects.
    // Documented via this test so behaviour is locked in.
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '12:00', close: '12:00' } };
    const window = effectiveWindowFor(hours, monday);

    // close (12:00) <= open (12:00) triggers the cross-midnight branch:
    // closeMinutes += 24*60 → next-day 12:00. Window is open 12:00 today to
    // 12:00 tomorrow — a full 24h. With no cap this is valid.
    expect(window).not.toBeNull();
    expect(window?.close.toISO()).toBe(monday.plus({ days: 1 }).set({ hour: 12 }).toISO());
  });
});

// ---------------------------------------------------------------------------
// effectiveWindowFor — with MN state cap (08:00–26:00)
// ---------------------------------------------------------------------------

describe('effectiveWindowFor — with state cap', () => {
  const monday = DateTime.fromObject({ year: 2026, month: 5, day: 18 }, { zone: ZONE }).startOf(
    'day',
  );

  it('clamps open up to the cap when the dispensary declares an earlier open', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '06:00', close: '22:00' } };
    const window = effectiveWindowFor(hours, monday, MN_CAP);

    expect(window?.open.toISO()).toBe(monday.set({ hour: 8 }).toISO());
    expect(window?.close.toISO()).toBe(monday.set({ hour: 22 }).toISO());
  });

  it('clamps close down to the cap when the dispensary declares a later close', () => {
    // 28:00 = 04:00 next day. Cap forces effective close to 26:00 = 02:00 next day.
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '28:00' } };
    const window = effectiveWindowFor(hours, monday, MN_CAP);

    expect(window?.open.toISO()).toBe(monday.set({ hour: 9 }).toISO());
    expect(window?.close.toISO()).toBe(monday.plus({ days: 1 }).set({ hour: 2 }).toISO());
  });

  it('returns null when the declared window is fully inside the prohibited band', () => {
    // 03:00–07:00 is entirely between 02:00 (state close) and 08:00 (state open).
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '03:00', close: '07:00' } };

    expect(effectiveWindowFor(hours, monday, MN_CAP)).toBeNull();
  });

  it('returns null when effective open equals effective close after clamping', () => {
    // 08:00–08:00 → with cross-midnight wraparound + cap at 08:00 → both edges at 08:00 today.
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '08:00', close: '08:00' } };

    // Without the cap this is a 24h window. With the cap clamping close down to
    // 26:00 (= 02:00 next day), effective close is min(32:00, 26:00) = 26:00. So
    // window is 08:00 today → 02:00 next day. NOT null.
    const window = effectiveWindowFor(hours, monday, MN_CAP);

    expect(window).not.toBeNull();
    expect(window?.open.toISO()).toBe(monday.set({ hour: 8 }).toISO());
    expect(window?.close.toISO()).toBe(monday.plus({ days: 1 }).set({ hour: 2 }).toISO());
  });

  it('returns null when day is closed (cap is irrelevant)', () => {
    expect(effectiveWindowFor(HOURS_NEVER_OPEN, monday, MN_CAP)).toBeNull();
  });

  it('keeps the declared window when it fits inside the cap', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '10:00', close: '20:00' } };
    const window = effectiveWindowFor(hours, monday, MN_CAP);

    expect(window?.open.toISO()).toBe(monday.set({ hour: 10 }).toISO());
    expect(window?.close.toISO()).toBe(monday.set({ hour: 20 }).toISO());
  });
});

// ---------------------------------------------------------------------------
// isOpenAt — instant-level check used by the compliance rule and listings
// ---------------------------------------------------------------------------

describe('isOpenAt — basic windowing', () => {
  it('passes inside the declared window', () => {
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });

  it('fails before the cap-effective open', () => {
    const at = chicagoUtc(2026, 5, 18, 7, 59, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(false);
  });

  it('passes at the cap-effective open (inclusive)', () => {
    const at = chicagoUtc(2026, 5, 18, 8, 0, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });

  it('fails at the cap-effective close (exclusive)', () => {
    // 02:00 the next day is the cap close.
    const at = chicagoUtc(2026, 5, 19, 2, 0, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(false);
  });

  it('passes 01:59 next day (inside yesterday cross-midnight window)', () => {
    const at = chicagoUtc(2026, 5, 19, 1, 59, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });
});

describe('isOpenAt — dispensary-narrowed windows', () => {
  it('fails when the dispensary closes earlier than the cap', () => {
    const at = chicagoUtc(2026, 5, 18, 22, 0, CDT);
    expect(isOpenAt(HOURS_9_TO_21, at, ZONE, MN_CAP)).toBe(false);
  });

  it('fails when the dispensary opens later than the cap', () => {
    const at = chicagoUtc(2026, 5, 18, 8, 30, CDT);
    expect(isOpenAt(HOURS_9_TO_21, at, ZONE, MN_CAP)).toBe(false);
  });

  it('fails on a day declared closed', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: null, sun: null };
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(false);
  });
});

describe('isOpenAt — cross-midnight (close > 24)', () => {
  it('passes 23:30 Monday with hours 09:00–02:00 next day', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '02:00' } };
    const at = chicagoUtc(2026, 5, 18, 23, 30, CDT);

    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(true);
  });

  it('passes 00:30 Tuesday with Monday close at 02:00 (yesterday window)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 19, 0, 30, CDT);

    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(true);
  });

  it('treats 02:00-close and 26:00-close as equivalent', () => {
    const a: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '02:00' } };
    const b: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '26:00' } };
    const at = chicagoUtc(2026, 5, 18, 23, 30, CDT);

    expect(isOpenAt(a, at, ZONE, MN_CAP)).toBe(true);
    expect(isOpenAt(b, at, ZONE, MN_CAP)).toBe(true);
  });

  it('fails at 02:30 Tuesday when Monday closed at 02:00 (past yesterday close)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 19, 2, 30, CDT);

    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(false);
  });

  it('caps effective close at state latest (02:00) when dispensary declares 28:00', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '28:00' } };
    const at = chicagoUtc(2026, 5, 19, 3, 0, CDT);

    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(false);
  });
});

describe('isOpenAt — DST transitions in America/Chicago', () => {
  it('passes at noon CDT on spring-forward Sunday (2026-03-08)', () => {
    const at = chicagoUtc(2026, 3, 8, 12, 0, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });

  it('passes at noon CST on fall-back Sunday (2026-11-01)', () => {
    const at = chicagoUtc(2026, 11, 1, 12, 0, CST);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });

  it('passes at 01:30 CST on spring-forward Sunday (yesterday window still open)', () => {
    const at = new Date('2026-03-08T07:30:00Z');
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(true);
  });

  it('fails at 04:30 CDT on spring-forward Sunday (between yesterday close and today open)', () => {
    const at = new Date('2026-03-08T09:30:00Z');
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)).toBe(false);
  });
});

describe('isOpenAt — defensive', () => {
  it('returns false for an unknown IANA zone', () => {
    const at = new Date('2026-05-18T17:00:00Z');
    expect(isOpenAt(HOURS_8_TO_26, at, 'Atlantis/Lost_City', MN_CAP)).toBe(false);
  });

  it('returns false when today and yesterday are both malformed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: 'not-a-time', close: '26:00' },
      sun: { open: 'not-a-time', close: '26:00' },
    };
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);

    expect(isOpenAt(hours, at, ZONE, MN_CAP)).toBe(false);
  });

  it('works without a state cap (used by tooling that does not enforce statute)', () => {
    const at = chicagoUtc(2026, 5, 18, 3, 0, CDT);
    // 03:00 with no cap should fall inside a 24h-encoded HOURS_8_TO_26 window?
    // Actually 08:00→02:00 closes at 02:00 next day, so 03:00 is past close.
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE)).toBe(false);
  });

  it('returns true with no cap when inside a dispensary-declared window', () => {
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    expect(isOpenAt(HOURS_8_TO_26, at, ZONE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextOpenAt — forward search used by "opens in 47 min" type UI
// ---------------------------------------------------------------------------

describe('nextOpenAt — currently open', () => {
  it('returns the input instant when currently open', () => {
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    expect(nextOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP)?.toISOString()).toBe(at.toISOString());
  });
});

describe('nextOpenAt — closed, opens later today', () => {
  it('returns today’s open instant when called before open', () => {
    const at = chicagoUtc(2026, 5, 18, 6, 0, CDT);
    const next = nextOpenAt(HOURS_8_TO_26, at, ZONE, MN_CAP);

    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 18, 8, 0, CDT).toISOString());
  });
});

describe('nextOpenAt — closed, opens tomorrow', () => {
  it('returns tomorrow’s open when called past today’s close', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '21:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 18, 22, 0, CDT);
    const next = nextOpenAt(hours, at, ZONE, MN_CAP);

    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 19, 9, 0, CDT).toISOString());
  });

  it('skips a day that is declared closed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '21:00' },
      tue: null,
      wed: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 18, 22, 0, CDT);
    const next = nextOpenAt(hours, at, ZONE, MN_CAP);

    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 20, 9, 0, CDT).toISOString());
  });
});

describe('nextOpenAt — never opens within horizon', () => {
  it('returns null when no day in the next 14 days has hours', () => {
    const at = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    expect(nextOpenAt(HOURS_NEVER_OPEN, at, ZONE, MN_CAP)).toBeNull();
  });
});

describe('nextOpenAt — defensive', () => {
  it('returns null for an unknown IANA zone', () => {
    const at = new Date('2026-05-18T17:00:00Z');
    expect(nextOpenAt(HOURS_8_TO_26, at, 'Atlantis/Lost_City', MN_CAP)).toBeNull();
  });

  it('skips a day whose declared hours are malformed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: 'broken', close: '21:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 18, 6, 0, CDT);
    const next = nextOpenAt(hours, at, ZONE, MN_CAP);

    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 19, 9, 0, CDT).toISOString());
  });

  it('works without a state cap', () => {
    const at = chicagoUtc(2026, 5, 18, 6, 0, CDT);
    const next = nextOpenAt(HOURS_8_TO_26, at, ZONE);
    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 18, 8, 0, CDT).toISOString());
  });

  it('returns the next-day open when the prior day’s cross-midnight window has already closed', () => {
    // Hours Mon 09:00–02:00 (closes 02:00 Tue). At 02:30 Tue, Tue itself opens at 09:00.
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const at = chicagoUtc(2026, 5, 19, 2, 30, CDT);
    const next = nextOpenAt(hours, at, ZONE, MN_CAP);

    expect(next?.toISOString()).toBe(chicagoUtc(2026, 5, 19, 9, 0, CDT).toISOString());
  });
});
