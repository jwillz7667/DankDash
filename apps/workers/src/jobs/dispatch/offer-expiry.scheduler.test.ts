/**
 * scheduleOfferExpiryJob wiring tests. Mirrors the dispatch scheduler
 * test — pins the cron expression and the orchestration error contract.
 */
import { describe, expect, it, vi } from 'vitest';

const scheduleMock = vi.fn();

vi.mock('node-cron', () => ({
  schedule: scheduleMock,
}));

const { OFFER_EXPIRY_CRON_EXPRESSION, scheduleOfferExpiryJob } =
  await import('./offer-expiry.scheduler.js');

describe('OFFER_EXPIRY_CRON_EXPRESSION', () => {
  it('fires every 10 seconds (coarser than dispatch — UX-latency only)', () => {
    expect(OFFER_EXPIRY_CRON_EXPRESSION).toBe('*/10 * * * * *');
  });
});

describe('scheduleOfferExpiryJob', () => {
  it('registers a node-cron task with the expiry expression and no timezone', () => {
    scheduleMock.mockReset();
    scheduleMock.mockReturnValue({ stop: vi.fn(), start: vi.fn() });

    const deps = {
      dispatchOffers: {} as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => ({}) } as never,
    };

    scheduleOfferExpiryJob(deps);

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]?.[0]).toBe('*/10 * * * * *');
    expect(typeof scheduleMock.mock.calls[0]?.[1]).toBe('function');
    expect(scheduleMock.mock.calls[0]?.[2]).toBeUndefined();
  });
});
