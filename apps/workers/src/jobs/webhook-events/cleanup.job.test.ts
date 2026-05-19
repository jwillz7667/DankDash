/**
 * Unit tests for the webhook events cleanup job.
 *
 * The job is a thin wrapper around WebhookEventsProcessedRepository.purgeExpired —
 * the integration test for the repo (in packages/db) covers the SQL.
 * Here we verify that the job (a) forwards `now` unchanged, (b) returns
 * the row count, and (c) logs through the child logger we requested.
 */
import { type WebhookEventsProcessedRepository } from '@dankdash/db';
import { describe, expect, it, vi } from 'vitest';
import { runWebhookEventsCleanupJob } from './cleanup.job.js';

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function makeLogger(): { logger: ReturnType<typeof makeLoggerInner>; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return { logger: makeLoggerInner(logs), logs };
}

function makeLoggerInner(logs: CapturedLog[]): {
  child: (fields: Record<string, unknown>) => unknown;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
} {
  return {
    child: (): unknown => makeLoggerInner(logs),
    info: (fields, message): void => {
      logs.push({ level: 'info', fields, message });
    },
    warn: (fields, message): void => {
      logs.push({ level: 'warn', fields, message });
    },
    error: (fields, message): void => {
      logs.push({ level: 'error', fields, message });
    },
  };
}

function makeRepo(purged: number): {
  webhookEvents: WebhookEventsProcessedRepository;
  calls: Date[];
} {
  const calls: Date[] = [];
  const repo = {
    purgeExpired: (now: Date): Promise<number> => {
      calls.push(now);
      return Promise.resolve(purged);
    },
  };
  return { webhookEvents: repo as unknown as WebhookEventsProcessedRepository, calls };
}

describe('runWebhookEventsCleanupJob', () => {
  it('passes the supplied `now` to purgeExpired and returns the count', async () => {
    const { webhookEvents, calls } = makeRepo(7);
    const { logger } = makeLogger();
    const now = new Date('2026-05-18T09:00:00.000Z');

    const summary = await runWebhookEventsCleanupJob({
      now,
      deps: { webhookEvents, logger: logger as never },
    });

    expect(calls).toEqual([now]);
    expect(summary.purged).toBe(7);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs start + completion through a child logger scoped to this job', async () => {
    const { webhookEvents } = makeRepo(0);
    const { logger, logs } = makeLogger();

    await runWebhookEventsCleanupJob({
      now: new Date('2026-05-18T09:00:00.000Z'),
      deps: { webhookEvents, logger: logger as never },
    });

    expect(logs).toEqual([
      {
        level: 'info',
        fields: { horizon: '2026-05-18T09:00:00.000Z' },
        message: 'webhook events cleanup started',
      },
      expect.objectContaining({ level: 'info', message: 'webhook events cleanup completed' }),
    ]);
    expect(logs[1]?.fields).toMatchObject({ purged: 0 });
  });

  it('surfaces purgeExpired rejections to the caller', async () => {
    const repo = {
      purgeExpired: vi.fn().mockRejectedValue(new Error('db unreachable')),
    } as unknown as WebhookEventsProcessedRepository;
    const { logger } = makeLogger();

    await expect(
      runWebhookEventsCleanupJob({
        now: new Date(),
        deps: { webhookEvents: repo, logger: logger as never },
      }),
    ).rejects.toThrow('db unreachable');
  });
});
