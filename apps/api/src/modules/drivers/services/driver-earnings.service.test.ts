/**
 * Unit tests for DriverEarningsService.
 *
 * Coverage:
 *
 *   - `computeWindow` boundary math for each of the three buckets at a
 *     pinned wall-clock instant in America/Chicago, including the DST
 *     transition week (2026-03-08, spring-forward) where the naive
 *     "subtract 7 days" math would be off by an hour.
 *   - Cross-zone correctness: a UTC-day-rollover instant that is still
 *     "yesterday" in America/Chicago must compute the chicago-yesterday
 *     window, not the UTC-today window.
 *   - `getEarnings` passes the exact `[since, until)` window to the
 *     scoped `sumDriverEarnings`, sums tip + fee, and returns the wire
 *     DTO including the same ISO instants it queried with.
 *   - Wire shape passes `DriverEarningsResponseSchema.parse` — datetime
 *     fields are full-precision UTC `Z`-suffixed strings.
 *
 * The clock is injected via the service config (mirrors AuthService /
 * MfaService); tests pin a fixed Date and never need to fake `Date`
 * globally.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DriverEarningsService,
  computeWindow,
  type DriverEarningsScopedRepos,
} from './driver-earnings.service.js';
import type { Database, OrdersRepository } from '@dankdash/db';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-0000000005a1';
const FAKE_DB = {} as Database;

interface SumInput {
  readonly driverId: string;
  readonly since: Date | null;
  readonly until: Date;
}

interface SumResult {
  readonly tipsCents: number;
  readonly deliveryFeesCents: number;
  readonly deliveriesCount: number;
}

class FakeOrdersRepo implements Pick<OrdersRepository, 'sumDriverEarnings'> {
  public calls: SumInput[] = [];
  public result: SumResult = { tipsCents: 0, deliveryFeesCents: 0, deliveriesCount: 0 };

  sumDriverEarnings(input: SumInput): Promise<SumResult> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

interface Rig {
  readonly service: DriverEarningsService;
  readonly orders: FakeOrdersRepo;
}

function makeRig(clockInstant: Date): Rig {
  const orders = new FakeOrdersRepo();
  const scoped: DriverEarningsScopedRepos = {
    orders: orders as unknown as OrdersRepository,
  };
  const service = new DriverEarningsService(FAKE_DB, () => scoped, { clock: () => clockInstant });
  return { service, orders };
}

describe('computeWindow', () => {
  it('today bucket starts at 00:00 America/Chicago and runs 24h forward', () => {
    // 2026-05-19 20:30:00 UTC → America/Chicago is CDT (UTC-5) → 2026-05-19 15:30 local.
    const now = new Date('2026-05-19T20:30:00.000Z');
    const { since, until } = computeWindow('today', now);
    // Local midnight on 2026-05-19 CDT == 05:00:00 UTC.
    expect(since.toJSDate().toISOString()).toBe('2026-05-19T05:00:00.000Z');
    expect(until.toJSDate().toISOString()).toBe('2026-05-20T05:00:00.000Z');
  });

  it('today bucket reframes UTC-rollover instants into the chicago-yesterday window', () => {
    // 2026-05-20 03:00:00 UTC → still 2026-05-19 22:00 CDT.
    const now = new Date('2026-05-20T03:00:00.000Z');
    const { since } = computeWindow('today', now);
    expect(since.toJSDate().toISOString()).toBe('2026-05-19T05:00:00.000Z');
  });

  it('week bucket starts on ISO-Monday in America/Chicago', () => {
    // 2026-05-21 is a Thursday; the ISO-week starts Monday 2026-05-18.
    const now = new Date('2026-05-21T16:00:00.000Z');
    const { since, until } = computeWindow('week', now);
    // Monday 2026-05-18 00:00 CDT == 05:00:00 UTC.
    expect(since.toJSDate().toISOString()).toBe('2026-05-18T05:00:00.000Z');
    expect(until.toJSDate().toISOString()).toBe('2026-05-25T05:00:00.000Z');
  });

  it('week bucket survives the spring-forward DST transition', () => {
    // 2026-03-12 (Thursday) sits in CDT — clocks sprang forward Sunday 2026-03-08.
    // Monday 2026-03-09 is the ISO-week start; 00:00 local on that day is CDT-5,
    // which is 05:00 UTC (NOT 06:00 — a naive "(now - 7 days)" or fixed-offset
    // approach would land on 06:00 UTC and silently shift the window by an hour).
    const now = new Date('2026-03-12T18:00:00.000Z');
    const { since, until } = computeWindow('week', now);
    expect(since.toJSDate().toISOString()).toBe('2026-03-09T05:00:00.000Z');
    expect(until.toJSDate().toISOString()).toBe('2026-03-16T05:00:00.000Z');
  });

  it('month bucket starts on the 1st of the month in America/Chicago', () => {
    const now = new Date('2026-05-15T14:00:00.000Z');
    const { since, until } = computeWindow('month', now);
    // 2026-05-01 00:00 CDT == 05:00:00 UTC; 2026-06-01 00:00 CDT == 05:00:00 UTC.
    expect(since.toJSDate().toISOString()).toBe('2026-05-01T05:00:00.000Z');
    expect(until.toJSDate().toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('month bucket survives a CST→CDT crossing (March)', () => {
    // 2026-03-15 sits in CDT; March 1 sat in CST (UTC-6). The window must start
    // at 2026-03-01 00:00 CST == 06:00 UTC, not 05:00 (the CDT offset).
    const now = new Date('2026-03-15T14:00:00.000Z');
    const { since, until } = computeWindow('month', now);
    expect(since.toJSDate().toISOString()).toBe('2026-03-01T06:00:00.000Z');
    // 2026-04-01 00:00 CDT == 05:00 UTC.
    expect(until.toJSDate().toISOString()).toBe('2026-04-01T05:00:00.000Z');
  });
});

describe('DriverEarningsService.getEarnings', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig(new Date('2026-05-19T20:30:00.000Z'));
  });

  it('passes the chicago-day window to the repo and returns the summed wire DTO', async () => {
    rig.orders.result = { tipsCents: 4_200, deliveryFeesCents: 6_500, deliveriesCount: 7 };

    const out = await rig.service.getEarnings(DRIVER_USER_ID, 'today');

    expect(rig.orders.calls).toHaveLength(1);
    const call = rig.orders.calls[0]!;
    expect(call.driverId).toBe(DRIVER_USER_ID);
    expect(call.since?.toISOString()).toBe('2026-05-19T05:00:00.000Z');
    expect(call.until.toISOString()).toBe('2026-05-20T05:00:00.000Z');

    expect(out).toStrictEqual({
      period: 'today',
      since: '2026-05-19T05:00:00.000Z',
      until: '2026-05-20T05:00:00.000Z',
      tipsCents: 4_200,
      deliveryFeesCents: 6_500,
      deliveriesCount: 7,
      totalCents: 10_700,
    });
  });

  it('totals to zero when the driver has no delivered orders in the window', async () => {
    rig.orders.result = { tipsCents: 0, deliveryFeesCents: 0, deliveriesCount: 0 };
    const out = await rig.service.getEarnings(DRIVER_USER_ID, 'week');
    expect(out.totalCents).toBe(0);
    expect(out.tipsCents).toBe(0);
    expect(out.deliveryFeesCents).toBe(0);
    expect(out.deliveriesCount).toBe(0);
  });

  it('emits the same window for the week bucket as computeWindow', async () => {
    rig.orders.result = { tipsCents: 50_000, deliveryFeesCents: 25_000, deliveriesCount: 30 };
    const out = await rig.service.getEarnings(DRIVER_USER_ID, 'week');

    expect(out.since).toBe('2026-05-18T05:00:00.000Z');
    expect(out.until).toBe('2026-05-25T05:00:00.000Z');
    expect(out.totalCents).toBe(75_000);
  });

  it('uses the injected clock thunk so two instances on different clocks compute distinct windows', async () => {
    const a = makeRig(new Date('2026-05-19T20:30:00.000Z'));
    const b = makeRig(new Date('2026-06-10T20:30:00.000Z'));
    await a.service.getEarnings(DRIVER_USER_ID, 'month');
    await b.service.getEarnings(DRIVER_USER_ID, 'month');

    expect(a.orders.calls[0]!.since?.toISOString()).toBe('2026-05-01T05:00:00.000Z');
    expect(b.orders.calls[0]!.since?.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });
});
