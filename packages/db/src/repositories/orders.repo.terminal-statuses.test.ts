import { describe, expect, it } from 'vitest';
import { LISTING_TERMINAL_STATUSES, TERMINAL_ORDER_STATUSES } from './orders.repo.js';
import { orderStatus } from '../schema/enums.js';

/**
 * Guards the customer Active/Past partition against the exact drift that
 * caused a `dispatch_failed` order to vanish from both tabs: the listing
 * bucket must stay a superset of the state-machine terminal set, never a
 * hand-maintained sibling that can fall out of sync.
 */
describe('order listing terminal-status partition', () => {
  it('includes dispatch_failed so failed-dispatch orders land in Past, not Active', () => {
    expect(LISTING_TERMINAL_STATUSES).toContain('dispatch_failed');
  });

  it('is a superset of the state-machine terminal set (every terminal state is "Past")', () => {
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(LISTING_TERMINAL_STATUSES).toContain(status);
    }
  });

  it('adds exactly one non-machine-terminal status: id_scan_failed (a door-scan failure reads as done)', () => {
    const extras = LISTING_TERMINAL_STATUSES.filter((s) => !TERMINAL_ORDER_STATUSES.includes(s));
    expect(extras).toEqual(['id_scan_failed']);
  });

  it('has no duplicate entries', () => {
    expect(new Set(LISTING_TERMINAL_STATUSES).size).toBe(LISTING_TERMINAL_STATUSES.length);
  });

  it('references only real order_status enum values', () => {
    for (const status of LISTING_TERMINAL_STATUSES) {
      expect(orderStatus.enumValues).toContain(status);
    }
  });
});
