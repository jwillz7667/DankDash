import { describe, expect, it } from 'vitest';
import {
  dayOfWeekLabel,
  deltaForBigger,
  formatCompactMoney,
  formatDaysSinceLastSale,
  formatMoney,
  formatPercent,
  formatWindowLabel,
  heatmapClass,
  hourLabel,
} from './format.js';

describe('formatCompactMoney', () => {
  it('formats cents under $1K with full precision', () => {
    expect(formatCompactMoney(12_345)).toMatch(/\$123/);
  });

  it('formats $1K+ as compact notation', () => {
    expect(formatCompactMoney(250_000)).toContain('K');
    expect(formatCompactMoney(2_500_000)).toContain('K');
  });

  it('renders "$—" for non-finite values', () => {
    expect(formatCompactMoney(Number.NaN)).toBe('$—');
    expect(formatCompactMoney(Number.POSITIVE_INFINITY)).toBe('$—');
  });
});

describe('formatMoney', () => {
  it('emits two-decimal currency', () => {
    expect(formatMoney(4500)).toBe('$45.00');
    expect(formatMoney(199)).toBe('$1.99');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('returns "$—" for NaN', () => {
    expect(formatMoney(Number.NaN)).toBe('$—');
  });
});

describe('formatPercent', () => {
  it('renders a rounded 0..1 ratio as percent', () => {
    expect(formatPercent(0.3217)).toBe('32.2%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('returns "—" for non-finite', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('deltaForBigger', () => {
  it('returns "new" when baseline is zero and current is positive', () => {
    expect(deltaForBigger(50, 0)).toEqual({ label: 'new', trend: 'up' });
  });

  it('returns flat label when both are zero', () => {
    expect(deltaForBigger(0, 0)).toEqual({ label: '—', trend: 'flat' });
  });

  it('returns "+12.5% vs prior" for a +12.5% delta', () => {
    expect(deltaForBigger(112_500, 100_000)).toEqual({ label: '+12.5% vs prior', trend: 'up' });
  });

  it('returns minus-signed delta for a drop', () => {
    const result = deltaForBigger(80_000, 100_000);
    expect(result.trend).toBe('down');
    expect(result.label).toContain('20.0%');
    expect(result.label.startsWith('−')).toBe(true);
  });

  it('treats sub-half-percent moves as flat', () => {
    expect(deltaForBigger(1_000, 1_001)).toEqual({ label: 'flat vs prior', trend: 'flat' });
  });

  it('handles non-finite input', () => {
    expect(deltaForBigger(Number.NaN, 100)).toEqual({ label: '—', trend: 'flat' });
  });
});

describe('heatmapClass', () => {
  it('returns the neutral surface fallback for null / 0', () => {
    expect(heatmapClass(null)).toContain('bg-surface-subtle');
    expect(heatmapClass(0)).toContain('bg-surface-subtle');
  });

  it('escalates through five moss steps', () => {
    expect(heatmapClass(0.1)).toContain('moss-100');
    expect(heatmapClass(0.3)).toContain('moss-200');
    expect(heatmapClass(0.5)).toContain('moss-300');
    expect(heatmapClass(0.7)).toContain('moss-400');
    expect(heatmapClass(0.95)).toContain('moss-500');
  });
});

describe('dayOfWeekLabel / hourLabel', () => {
  it('labels day-of-week 0..6 as Sun..Sat', () => {
    expect(dayOfWeekLabel(0)).toBe('Sun');
    expect(dayOfWeekLabel(6)).toBe('Sat');
  });

  it('pads hour to 2 digits', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(7)).toBe('07:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});

describe('formatWindowLabel', () => {
  it('renders "May 13 – May 19" for a same-year window', () => {
    const label = formatWindowLabel(
      '2026-05-13T00:00:00.000Z',
      '2026-05-20T00:00:00.000Z',
      new Date('2026-05-20T12:00:00.000Z'),
    );
    expect(label).toContain('May 13');
    expect(label).toContain('May 19');
  });

  it('includes the year when the window straddles last year', () => {
    const label = formatWindowLabel(
      '2025-12-30T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z',
      new Date('2026-05-20T12:00:00.000Z'),
    );
    expect(label).toContain('2025');
  });
});

describe('formatDaysSinceLastSale', () => {
  it('renders "Never" for null', () => {
    expect(formatDaysSinceLastSale(null)).toBe('Never');
  });

  it('renders "Today" for 0', () => {
    expect(formatDaysSinceLastSale(0)).toBe('Today');
  });

  it('renders singular "1 day ago"', () => {
    expect(formatDaysSinceLastSale(1)).toBe('1 day ago');
  });

  it('renders plural day count', () => {
    expect(formatDaysSinceLastSale(12)).toBe('12 days ago');
  });
});
