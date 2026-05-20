import { describe, expect, it } from 'vitest';
import { formatMilesShort, formatMinutes, formatOrderShort, formatUsdCents } from './format.js';

describe('formatUsdCents', () => {
  it('formats whole-dollar cents with $ prefix and two decimals', () => {
    expect(formatUsdCents(0)).toBe('$0.00');
    expect(formatUsdCents(100)).toBe('$1.00');
    expect(formatUsdCents(2_499)).toBe('$24.99');
    expect(formatUsdCents(123_456)).toBe('$1,234.56');
  });
});

describe('formatMilesShort', () => {
  it('renders one decimal with " mi" suffix', () => {
    expect(formatMilesShort(0)).toBe('0.0 mi');
    expect(formatMilesShort(1.234)).toBe('1.2 mi');
    // Use 12.96 not 12.95 — IEEE-754 stores 12.95 as 12.94999... so
    // toFixed(1) produces '12.9' which is technically correct but
    // confusing in a "rounds up" assertion. 12.96 round-trips cleanly.
    expect(formatMilesShort(12.96)).toBe('13.0 mi');
  });
});

describe('formatMinutes', () => {
  it('returns "less than a minute" for 0 and negative inputs', () => {
    expect(formatMinutes(0)).toBe('less than a minute');
    expect(formatMinutes(-3)).toBe('less than a minute');
  });

  it('singularizes "1 minute"', () => {
    expect(formatMinutes(1)).toBe('1 minute');
  });

  it('pluralizes anything > 1', () => {
    expect(formatMinutes(2)).toBe('2 minutes');
    expect(formatMinutes(90)).toBe('90 minutes');
  });
});

describe('formatOrderShort', () => {
  it('takes the first 8 hex chars uppercased and prefixes with #', () => {
    expect(formatOrderShort('01935f3d-0000-7000-8000-0000000000aa')).toBe('#01935F3D');
  });

  it('handles inputs shorter than 8 chars without throwing', () => {
    expect(formatOrderShort('abc')).toBe('#ABC');
  });
});
