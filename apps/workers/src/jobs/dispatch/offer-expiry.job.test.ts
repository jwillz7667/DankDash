/**
 * Unit tests for runOfferExpiryJob. The job flips stale offers to
 * `expired` (via `DispatchOffersRepository.expireStale`, covered by the
 * repo integration test) and fans an `offer:expired` realtime envelope to
 * each affected driver. Here we verify:
 *   - the supplied `now` is passed through unchanged
 *   - the expired-row count is returned in the summary
 *   - non-zero results are logged at info; zero results stay quiet
 *     (the 10s cron would otherwise dominate the log stream)
 *   - one `offer:expired` envelope is published per expired offer, carrying
 *     the offer/order/driver ids and the expiry timestamp
 *   - a single publish failure is logged and does not abort the rest
 *   - repo rejections still surface to the caller
 */
import { type DispatchOffersRepository, type ExpiredOffer } from '@dankdash/db';
import { type PublishRealtimeEventInput } from '@dankdash/realtime-events';
import { describe, expect, it, vi } from 'vitest';
import { runOfferExpiryJob } from './offer-expiry.job.js';

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): {
  logger: {
    info: (f: Record<string, unknown>, m: string) => void;
    warn: (f: Record<string, unknown>, m: string) => void;
    error: (f: Record<string, unknown>, m: string) => void;
    child: () => unknown;
  };
  logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  const logger = {
    child: (): unknown => logger,
    info: (fields: Record<string, unknown>, message: string): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields: Record<string, unknown>, message: string): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields: Record<string, unknown>, message: string): void => {
      logs.push({ level: 'error', fields, message });
    },
  };
  return { logger, logs };
}

function makeExpired(seq: number): ExpiredOffer {
  return {
    id: `00000000-0000-7000-8000-00000000000${seq}`,
    orderId: `00000000-0000-7000-8000-0000000000f${seq}`,
    driverId: `00000000-0000-7000-8000-0000000000d${seq}`,
  };
}

describe('runOfferExpiryJob', () => {
  it('passes the supplied `now` to expireStale and returns the count', async () => {
    const calls: Date[] = [];
    const repo = {
      expireStale: (now: Date): Promise<readonly ExpiredOffer[]> => {
        calls.push(now);
        return Promise.resolve([makeExpired(1), makeExpired(2), makeExpired(3)]);
      },
    } as unknown as DispatchOffersRepository;
    const { logger } = makeLogger();
    const now = new Date('2026-05-19T18:00:00.000Z');

    const summary = await runOfferExpiryJob({
      now,
      deps: { dispatchOffers: repo, logger: logger as never },
    });

    expect(calls).toEqual([now]);
    expect(summary).toEqual({ expired: 3 });
  });

  it('logs at info when at least one offer expired', async () => {
    const repo = {
      expireStale: vi.fn().mockResolvedValue([makeExpired(1), makeExpired(2)]),
    } as unknown as DispatchOffersRepository;
    const { logger, logs } = makeLogger();
    const now = new Date('2026-05-19T18:00:00.000Z');

    await runOfferExpiryJob({
      now,
      deps: { dispatchOffers: repo, logger: logger as never },
    });

    expect(logs).toEqual([
      {
        level: 'info',
        fields: { expired: 2, horizon: '2026-05-19T18:00:00.000Z' },
        message: 'dispatch: expired stale offers',
      },
    ]);
  });

  it('stays silent when no offers were eligible', async () => {
    const repo = {
      expireStale: vi.fn().mockResolvedValue([]),
    } as unknown as DispatchOffersRepository;
    const { logger, logs } = makeLogger();

    await runOfferExpiryJob({
      now: new Date(),
      deps: { dispatchOffers: repo, logger: logger as never },
    });

    expect(logs).toEqual([]);
  });

  it('publishes one offer:expired envelope per expired offer', async () => {
    const rows = [makeExpired(1), makeExpired(2)];
    const repo = {
      expireStale: vi.fn().mockResolvedValue(rows),
    } as unknown as DispatchOffersRepository;
    const { logger } = makeLogger();
    const published: PublishRealtimeEventInput[] = [];
    const now = new Date('2026-05-19T18:00:00.000Z');
    let idSeq = 0;

    await runOfferExpiryJob({
      now,
      deps: {
        dispatchOffers: repo,
        logger: logger as never,
        publish: (input) => {
          published.push(input);
          return Promise.resolve(`0-${published.length}`);
        },
        idGen: () => `id-${(idSeq += 1)}`,
      },
    });

    expect(published).toEqual([
      {
        id: 'id-1',
        emittedAt: '2026-05-19T18:00:00.000Z',
        source: 'workers',
        event: {
          type: 'offer:expired',
          payload: {
            offerId: rows[0]!.id,
            orderId: rows[0]!.orderId,
            driverId: rows[0]!.driverId,
            expiredAt: '2026-05-19T18:00:00.000Z',
          },
        },
      },
      {
        id: 'id-2',
        emittedAt: '2026-05-19T18:00:00.000Z',
        source: 'workers',
        event: {
          type: 'offer:expired',
          payload: {
            offerId: rows[1]!.id,
            orderId: rows[1]!.orderId,
            driverId: rows[1]!.driverId,
            expiredAt: '2026-05-19T18:00:00.000Z',
          },
        },
      },
    ]);
  });

  it('isolates a single publish failure and still publishes the rest', async () => {
    const rows = [makeExpired(1), makeExpired(2)];
    const repo = {
      expireStale: vi.fn().mockResolvedValue(rows),
    } as unknown as DispatchOffersRepository;
    const { logger, logs } = makeLogger();
    const okIds: string[] = [];

    const summary = await runOfferExpiryJob({
      now: new Date('2026-05-19T18:00:00.000Z'),
      deps: {
        dispatchOffers: repo,
        logger: logger as never,
        publish: (input) => {
          if (input.event.type === 'offer:expired' && input.event.payload.offerId === rows[0]!.id) {
            return Promise.reject(new Error('xadd down'));
          }
          okIds.push(input.event.type === 'offer:expired' ? input.event.payload.offerId : '');
          return Promise.resolve('0-1');
        },
        idGen: () => 'id',
      },
    });

    // Second offer still published despite the first failing.
    expect(okIds).toEqual([rows[1]!.id]);
    // The failure was logged, not thrown, and did not touch the summary.
    expect(summary).toEqual({ expired: 2 });
    const warned = logs.filter((l) => l.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ offerId: rows[0]!.id });
  });

  it('surfaces repo rejections to the caller', async () => {
    const repo = {
      expireStale: vi.fn().mockRejectedValue(new Error('db gone')),
    } as unknown as DispatchOffersRepository;
    const { logger } = makeLogger();

    await expect(
      runOfferExpiryJob({
        now: new Date(),
        deps: { dispatchOffers: repo, logger: logger as never },
      }),
    ).rejects.toThrow('db gone');
  });
});
