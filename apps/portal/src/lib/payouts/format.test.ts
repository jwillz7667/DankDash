import { describe, expect, it } from 'vitest';
import {
  formatCustomerShortName,
  formatPeriodDate,
  formatPeriodRange,
  formatTimestamp,
  payoutStatusBadge,
} from './format.js';

describe('formatPeriodDate', () => {
  it('renders YYYY-MM-DD as "Mon D, YYYY" in UTC', () => {
    expect(formatPeriodDate('2026-05-17')).toBe('May 17, 2026');
  });

  it('returns the input verbatim when it is not a valid date string', () => {
    expect(formatPeriodDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatPeriodRange', () => {
  it('collapses to a single date when periodEnd is exactly one day after periodStart', () => {
    expect(formatPeriodRange('2026-05-17', '2026-05-18')).toBe('May 17, 2026');
  });

  it('renders an "A – B" range for multi-day windows with the inclusive upper bound', () => {
    expect(formatPeriodRange('2026-05-10', '2026-05-18')).toBe('May 10, 2026 – May 17, 2026');
  });

  it('falls back to the raw strings when either date is unparsable', () => {
    expect(formatPeriodRange('2026-05-17', 'invalid')).toBe('2026-05-17 – invalid');
  });
});

describe('formatTimestamp', () => {
  it('returns "—" for null', () => {
    expect(formatTimestamp(null)).toBe('—');
  });

  it('renders an ISO-8601 instant in America/Chicago with the abbreviation', () => {
    const result = formatTimestamp('2026-05-18T08:15:00.000Z');
    // 2026-05-18T08:15 UTC = 03:15 CDT.
    expect(result).toMatch(/May 18, 2026/);
    expect(result).toMatch(/3:15/);
    expect(result).toMatch(/CDT|CST/);
  });

  it('returns "—" for an unparseable input', () => {
    expect(formatTimestamp('not-a-timestamp')).toBe('—');
  });
});

describe('payoutStatusBadge', () => {
  it('labels "completed" payouts as "Paid"', () => {
    expect(payoutStatusBadge('completed').label).toBe('Paid');
  });

  it('uses moss tones for the paid badge', () => {
    expect(payoutStatusBadge('completed').className).toContain('moss');
  });

  it('uses the danger token for the failed badge', () => {
    expect(payoutStatusBadge('failed').className).toContain('bg-danger-soft');
    expect(payoutStatusBadge('failed').className).toContain('text-danger');
  });

  it('uses the warning token for processing', () => {
    expect(payoutStatusBadge('processing').className).toContain('bg-warning-soft');
    expect(payoutStatusBadge('processing').className).toContain('text-warning');
  });

  it('uses neutral surface tones for pending / canceled', () => {
    expect(payoutStatusBadge('pending').className).toContain('bg-surface-subtle');
    expect(payoutStatusBadge('canceled').className).toContain('bg-surface-subtle');
  });
});

describe('formatCustomerShortName', () => {
  it('renders "Jane D." for first + last', () => {
    expect(formatCustomerShortName('Jane', 'Doe')).toBe('Jane D.');
  });

  it('returns just the first name when no last name', () => {
    expect(formatCustomerShortName('Jane', null)).toBe('Jane');
  });

  it('returns the last initial when only last name is known', () => {
    expect(formatCustomerShortName(null, 'Doe')).toBe('D.');
  });

  it('falls back to "Customer" when both names are absent', () => {
    expect(formatCustomerShortName(null, null)).toBe('Customer');
    expect(formatCustomerShortName('', '')).toBe('Customer');
  });

  it('trims whitespace before deciding', () => {
    expect(formatCustomerShortName('  ', '  ')).toBe('Customer');
    expect(formatCustomerShortName(' Jane ', ' Doe ')).toBe('Jane D.');
  });
});
