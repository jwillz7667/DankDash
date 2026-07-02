import { describe, expect, it } from 'vitest';
import {
  datetimeLocalToIso,
  formatMinSubtotal,
  formatPromoDateTime,
  formatPromoValue,
  formatPromoWindow,
  formatRedemptions,
  isValidPromoCode,
  normalizePromoCode,
  parseOptionalWholeNumber,
  parsePercent,
  promoTypeLabel,
  toDatetimeLocalValue,
} from './format.js';

describe('formatPromoValue', () => {
  it('renders a percent discount', () => {
    expect(formatPromoValue({ type: 'percent', value: 10 })).toBe('10% off');
  });

  it('renders a fixed amount from cents', () => {
    expect(formatPromoValue({ type: 'fixed_amount', value: 500 })).toBe('$5.00 off');
  });

  it('renders free delivery', () => {
    expect(formatPromoValue({ type: 'free_delivery', value: 0 })).toBe('Free delivery');
  });
});

describe('promoTypeLabel', () => {
  it('labels each type', () => {
    expect(promoTypeLabel('percent')).toBe('Percent off');
    expect(promoTypeLabel('fixed_amount')).toBe('Amount off');
    expect(promoTypeLabel('free_delivery')).toBe('Free delivery');
  });
});

describe('formatMinSubtotal', () => {
  it('shows "None" for a zero floor', () => {
    expect(formatMinSubtotal(0)).toBe('None');
  });

  it('formats a dollar floor from cents', () => {
    expect(formatMinSubtotal(2500)).toBe('$25.00');
  });
});

describe('formatRedemptions', () => {
  it('renders used over a finite cap', () => {
    expect(formatRedemptions(12, 100)).toBe('12 / 100');
  });

  it('renders infinity for an unlimited cap', () => {
    expect(formatRedemptions(12, null)).toBe('12 / ∞');
  });
});

describe('formatPromoDateTime / formatPromoWindow', () => {
  it('renders an ISO instant in America/Chicago', () => {
    // 2026-07-02T18:30Z is 1:30 PM CDT.
    expect(formatPromoDateTime('2026-07-02T18:30:00.000Z')).toBe('Jul 2, 2026, 1:30 PM CDT');
  });

  it('renders "No end" for an open-ended window', () => {
    expect(formatPromoWindow('2026-07-02T18:30:00.000Z', null)).toBe(
      'Jul 2, 2026, 1:30 PM CDT → No end',
    );
  });
});

describe('normalizePromoCode / isValidPromoCode', () => {
  it('uppercases and trims', () => {
    expect(normalizePromoCode('  summer-10 ')).toBe('SUMMER-10');
  });

  it('accepts a valid code', () => {
    expect(isValidPromoCode('SUMMER-10')).toBe(true);
  });

  it('rejects too-short, lowercase, or illegal-character codes', () => {
    expect(isValidPromoCode('AB')).toBe(false);
    expect(isValidPromoCode('summer')).toBe(false);
    expect(isValidPromoCode('SUMMER 10')).toBe(false);
    expect(isValidPromoCode('A'.repeat(41))).toBe(false);
  });
});

describe('parsePercent', () => {
  it('accepts a whole percent in range', () => {
    expect(parsePercent('10')).toBe(10);
    expect(parsePercent('100')).toBe(100);
  });

  it('rejects zero, over 100, fractional, and non-numeric input', () => {
    expect(parsePercent('0')).toBeNull();
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('10.5')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
  });
});

describe('parseOptionalWholeNumber', () => {
  it('returns null for empty input (the "unlimited"/default case)', () => {
    expect(parseOptionalWholeNumber('   ')).toBeNull();
  });

  it('returns undefined for malformed input', () => {
    expect(parseOptionalWholeNumber('1.5')).toBeUndefined();
    expect(parseOptionalWholeNumber('-1')).toBeUndefined();
    expect(parseOptionalWholeNumber('x')).toBeUndefined();
  });

  it('parses a whole number', () => {
    expect(parseOptionalWholeNumber('100')).toBe(100);
  });
});

describe('datetime-local ⇄ ISO bridge', () => {
  it('round-trips a local wall-clock through UTC and back to the same instant', () => {
    const instant = new Date(2026, 6, 2, 14, 30, 0, 0);
    const local = toDatetimeLocalValue(instant);
    const iso = datetimeLocalToIso(local);
    expect(iso).toBe(instant.toISOString());
  });

  it('returns null for empty or malformed input', () => {
    expect(datetimeLocalToIso('')).toBeNull();
    expect(datetimeLocalToIso('not-a-date')).toBeNull();
  });
});
