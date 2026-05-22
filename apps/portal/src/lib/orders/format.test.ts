import { describe, expect, it } from 'vitest';
import { ageTone, formatMoney, formatRelativeTime, formatShortCode } from './format.js';

describe('formatMoney', () => {
  it('formats integer cents into $X.XX', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(100)).toBe('$1.00');
    expect(formatMoney(6210)).toBe('$62.10');
    expect(formatMoney(1234567)).toBe('$12,345.67');
  });

  it('returns "$—" for non-finite input rather than NaN-printing', () => {
    expect(formatMoney(Number.NaN)).toBe('$—');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('$—');
  });

  it('handles negative values with a minus sign (no parens) so they sort visually with positives', () => {
    expect(formatMoney(-500)).toContain('-');
    expect(formatMoney(-500)).toContain('5.00');
  });
});

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-05-19T12:00:00.000Z');

  it('returns "just now" when within 30 seconds', () => {
    expect(formatRelativeTime('2026-05-19T11:59:55.000Z', NOW)).toBe('just now');
    expect(formatRelativeTime('2026-05-19T12:00:00.000Z', NOW)).toBe('just now');
  });

  it('returns Xs ago for 30s < t < 1m', () => {
    expect(formatRelativeTime('2026-05-19T11:59:25.000Z', NOW)).toBe('35s ago');
  });

  it('returns Xm ago when between one minute and one hour', () => {
    expect(formatRelativeTime('2026-05-19T11:58:00.000Z', NOW)).toBe('2m ago');
    expect(formatRelativeTime('2026-05-19T11:01:00.000Z', NOW)).toBe('59m ago');
  });

  it('returns Xh ago on the hour boundary (no trailing 0m)', () => {
    expect(formatRelativeTime('2026-05-19T10:00:00.000Z', NOW)).toBe('2h ago');
  });

  it('returns Xh Ym ago when there are spare minutes', () => {
    expect(formatRelativeTime('2026-05-19T08:42:00.000Z', NOW)).toBe('3h 18m ago');
  });

  it('switches to absolute date for ≥ 1 day stale entries (visual flag for the operator)', () => {
    const out = formatRelativeTime('2026-05-15T12:00:00.000Z', NOW);
    expect(out).toMatch(/May/u);
    expect(out).not.toMatch(/ago/u);
  });

  it('returns "—" for an unparseable timestamp instead of throwing', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('—');
  });

  it('clamps negative diffs (future timestamps) to "just now" rather than printing a negative count', () => {
    expect(formatRelativeTime('2026-05-19T12:00:05.000Z', NOW)).toBe('just now');
  });
});

describe('formatShortCode', () => {
  it('prefixes with #', () => {
    expect(formatShortCode('A1B2')).toBe('#A1B2');
  });
});

describe('ageTone', () => {
  const NOW = new Date('2026-05-19T12:00:00.000Z');

  it('returns success for fresh (< 5 min) orders', () => {
    expect(ageTone('2026-05-19T11:59:59.000Z', NOW)).toBe('success');
    expect(ageTone('2026-05-19T11:55:01.000Z', NOW)).toBe('success');
  });

  it('returns warning at the 5-minute boundary and through 10 minutes', () => {
    expect(ageTone('2026-05-19T11:55:00.000Z', NOW)).toBe('warning');
    expect(ageTone('2026-05-19T11:50:01.000Z', NOW)).toBe('warning');
  });

  it('returns danger at and beyond the 10-minute boundary', () => {
    expect(ageTone('2026-05-19T11:50:00.000Z', NOW)).toBe('danger');
    expect(ageTone('2026-05-19T11:00:00.000Z', NOW)).toBe('danger');
  });

  it('treats future timestamps as fresh (clamps negative diffs)', () => {
    expect(ageTone('2026-05-19T12:05:00.000Z', NOW)).toBe('success');
  });

  it('falls back to success on an unparseable timestamp rather than blocking the paint', () => {
    expect(ageTone('not a date', NOW)).toBe('success');
  });
});
