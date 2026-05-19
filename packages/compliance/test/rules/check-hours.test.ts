/**
 * Hours rule — every case from CLAUDE-CODE-PHASES.md §3.5 plus the
 * cross-midnight and DST transitions.
 *
 * Helpers below convert "May 18 2026, 7:59 AM in America/Chicago" into the
 * corresponding UTC `Date`, which is what production code receives from
 * the request layer. May is on CDT (-05:00); March before the DST start
 * is on CST (-06:00).
 *
 * Dates referenced:
 *   - 2026-05-18 (Mon) — mid-spring weekday, comfortably mid-DST.
 *   - 2026-03-08 (Sun) — DST spring-forward at 02:00 CST → 03:00 CDT.
 *   - 2026-11-01 (Sun) — DST fall-back at 02:00 CDT → 01:00 CST.
 */
import { describe, expect, it } from 'vitest';
import { checkHours, type DispensaryHours } from '../../src/index.js';
import { makeContext, makeDispensary } from '../fixtures.js';

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

/** DST = America/Chicago CDT offset (UTC+5). */
const CDT = 5;
/** Non-DST = America/Chicago CST offset (UTC+6). */
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

describe('checkHours — state-window edges', () => {
  it('fails at 07:59 AM (before state earliestOpen)', () => {
    const now = chicagoUtc(2026, 5, 18, 7, 59, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('passes at 08:00 AM (state earliestOpen, inclusive)', () => {
    const now = chicagoUtc(2026, 5, 18, 8, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('passes at 01:59 AM next day (still inside yesterday window)', () => {
    const now = chicagoUtc(2026, 5, 19, 1, 59, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('fails at exactly 02:00 AM (state latestClose, exclusive)', () => {
    const now = chicagoUtc(2026, 5, 19, 2, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });
});

describe('checkHours — dispensary-window narrowing', () => {
  it('fails at 22:00 when dispensary closes at 21:00 (even though state allows)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '21:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 22, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('fails at 08:30 when dispensary opens at 09:00 (narrower than state)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '21:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 8, 30, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('fails when the dispensary is closed today (null entry)', () => {
    const hours: DispensaryHours = { ...HOURS_8_TO_26, mon: null };
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('passes a normal 12:00 Monday mid-day query', () => {
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });
});

describe('checkHours — cross-midnight (close > 24)', () => {
  it('passes 23:30 Monday with hours 09:00–02:00 next day', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 23, 30, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('passes 00:30 Tuesday with Monday close at 02:00 (yesterday window)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const now = chicagoUtc(2026, 5, 19, 0, 30, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('passes 23:30 Monday whether close is encoded as 02:00 or 26:00', () => {
    const a: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '02:00' } };
    const b: DispensaryHours = { ...HOURS_8_TO_26, mon: { open: '09:00', close: '26:00' } };
    const now = chicagoUtc(2026, 5, 18, 23, 30, CDT);

    expect(
      checkHours(makeContext({ dispensary: makeDispensary({ hoursJson: a }) }), now).passed,
    ).toBe(true);
    expect(
      checkHours(makeContext({ dispensary: makeDispensary({ hoursJson: b }) }), now).passed,
    ).toBe(true);
  });

  it('fails at 02:30 Tuesday when Monday closed at 02:00 (past yesterday close)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '02:00' },
      tue: { open: '09:00', close: '21:00' },
    };
    const now = chicagoUtc(2026, 5, 19, 2, 30, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('caps effective close at state latest (02:00) when dispensary declares 28:00', () => {
    // Dispensary tries to stay open until 04:00 next day. State cap forces
    // effective close to 02:00 next day. Query at 03:00 AM Tuesday is past
    // the cap and must fail even though inside the declared window.
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '09:00', close: '28:00' },
    };
    const now = chicagoUtc(2026, 5, 19, 3, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });
});

describe('checkHours — DST transitions in America/Chicago', () => {
  it('handles a query at noon on spring-forward Sunday', () => {
    // 2026-03-08 is the spring-forward Sunday. Noon CDT = 17:00 UTC.
    const now = chicagoUtc(2026, 3, 8, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('handles a query at noon on fall-back Sunday', () => {
    // 2026-11-01 is the fall-back Sunday. Noon CST = 18:00 UTC.
    const now = chicagoUtc(2026, 11, 1, 12, 0, CST);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('passes at 01:30 AM (CST, pre-jump) on spring-forward Sunday — yesterday window still open', () => {
    // 01:30 AM CST Sunday = 07:30 UTC.
    const now = new Date('2026-03-08T07:30:00Z');
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(true);
  });

  it('fails at 04:30 AM CDT on spring-forward Sunday — between yesterday close and today open', () => {
    // 04:30 AM CDT Sunday = 09:30 UTC.
    const now = new Date('2026-03-08T09:30:00Z');
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });
});

describe('checkHours — defensive parsing', () => {
  it('fails with invalid_timezone for an unknown IANA zone', () => {
    const now = new Date('2026-05-18T17:00:00Z');
    const ctx = makeContext({ dispensary: makeDispensary({ timezone: 'Atlantis/Lost_City' }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
    expect(res.details['reason']).toBe('invalid_timezone');
  });

  it('fails when both today and yesterday hours are malformed', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: 'not-a-time', close: '26:00' },
      sun: { open: 'not-a-time', close: '26:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('fails when minutes are out of range', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '08:99', close: '26:00' },
      sun: { open: '08:60', close: '26:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('fails when hour is out of range (e.g. 31:00)', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '08:00', close: '31:00' },
      sun: { open: '08:00', close: '31:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('fails when dispensary window is fully inside the prohibited 02:00-08:00 band', () => {
    const hours: DispensaryHours = {
      ...HOURS_8_TO_26,
      mon: { open: '03:00', close: '07:00' },
      sun: { open: '03:00', close: '07:00' },
    };
    const now = chicagoUtc(2026, 5, 18, 5, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: hours }) });

    const res = checkHours(ctx, now);

    expect(res.passed).toBe(false);
  });

  it('echoes localNow, timezone, todayWindow, yesterdayWindow in details', () => {
    const now = chicagoUtc(2026, 5, 18, 12, 0, CDT);
    const ctx = makeContext({ dispensary: makeDispensary({ hoursJson: HOURS_8_TO_26 }) });

    const res = checkHours(ctx, now);

    expect(res.details).toMatchObject({
      timezone: 'America/Chicago',
    });
    expect(typeof res.details['localNow']).toBe('string');
    expect(res.details['todayWindow']).toBeDefined();
    expect(res.details['yesterdayWindow']).toBeDefined();
  });
});
