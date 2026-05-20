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

  it('uses rose tones for the failed badge', () => {
    expect(payoutStatusBadge('failed').className).toContain('rose');
  });

  it('uses amber tones for processing', () => {
    expect(payoutStatusBadge('processing').className).toContain('amber');
  });

  it('uses slate tones for pending / canceled', () => {
    expect(payoutStatusBadge('pending').className).toContain('slate');
    expect(payoutStatusBadge('canceled').className).toContain('slate');
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
