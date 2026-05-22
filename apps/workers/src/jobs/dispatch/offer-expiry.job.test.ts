/**
 * Unit tests for runOfferExpiryJob. The job is a one-line wrapper
 * around `DispatchOffersRepository.expireStale`; the integration test
 * for the repo covers the SQL. Here we verify:
 *   - the supplied `now` is passed through unchanged
 *   - the row count is returned in the summary
 *   - non-zero results are logged at info; zero results stay quiet
 *     (the 10s cron would otherwise dominate the log stream)
 */
import { type DispatchOffersRepository } from '@dankdash/db';
import { describe, expect, it, vi } from 'vitest';
import { runOfferExpiryJob } from './offer-expiry.job.js';

interface CapturedLog {
  readonly level: 'info' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): {
  logger: {
    info: (f: Record<string, unknown>, m: string) => void;
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
    error: (fields: Record<string, unknown>, message: string): void => {
      logs.push({ level: 'error', fields, message });
    },
  };
  return { logger, logs };
}

describe('runOfferExpiryJob', () => {
  it('passes the supplied `now` to expireStale and returns the count', async () => {
    const calls: Date[] = [];
    const repo = {
      expireStale: (now: Date): Promise<number> => {
        calls.push(now);
        return Promise.resolve(3);
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
      expireStale: vi.fn().mockResolvedValue(2),
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
      expireStale: vi.fn().mockResolvedValue(0),
    } as unknown as DispatchOffersRepository;
    const { logger, logs } = makeLogger();

    await runOfferExpiryJob({
      now: new Date(),
      deps: { dispatchOffers: repo, logger: logger as never },
    });

    expect(logs).toEqual([]);
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
