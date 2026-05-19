/**
 * scheduleWebhookEventsCleanupJob wiring tests. Mirrors the payouts
 * scheduler test — pins the constants and confirms node-cron receives
 * the right expression / timezone tuple.
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const {
  WEBHOOK_EVENTS_CLEANUP_CRON_EXPRESSION,
  WEBHOOK_EVENTS_CLEANUP_CRON_TIMEZONE,
  scheduleWebhookEventsCleanupJob,
} = await import('./cleanup.scheduler.js');

describe('WEBHOOK_EVENTS_CLEANUP_CRON constants', () => {
  it('fires at 04:00 every day, America/Chicago', () => {
    expect(WEBHOOK_EVENTS_CLEANUP_CRON_EXPRESSION).toBe('0 4 * * *');
    expect(WEBHOOK_EVENTS_CLEANUP_CRON_TIMEZONE).toBe('America/Chicago');
  });
});

describe('scheduleWebhookEventsCleanupJob', () => {
  it('registers a node-cron task with the cleanup expression and timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      webhookEvents: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({}) } as never,
    };

    scheduleWebhookEventsCleanupJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('0 4 * * *');
    expect(scheduleMock.mock.calls[0]?.[2]).toEqual({ timezone: 'America/Chicago' });
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
  });
});
