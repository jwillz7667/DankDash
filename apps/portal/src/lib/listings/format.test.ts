import { describe, expect, it } from 'vitest';
import {
  formatCentsForInput,
  formatSyncedLabel,
  parseInputToCents,
  parseInputToQuantity,
  syncStaleness,
} from './format.js';

describe('formatCentsForInput', () => {
  it('formats whole-dollar values with a trailing .00', () => {
    expect(formatCentsForInput(1500)).toBe('15.00');
  });

  it('formats sub-dollar values without rounding', () => {
    expect(formatCentsForInput(199)).toBe('1.99');
  });

  it('formats zero cleanly', () => {
    expect(formatCentsForInput(0)).toBe('0.00');
  });

  it('returns the empty string for non-finite input', () => {
    expect(formatCentsForInput(Number.NaN)).toBe('');
    expect(formatCentsForInput(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('parseInputToCents', () => {
  it('parses dollar-string values to cents', () => {
    expect(parseInputToCents('15.00')).toBe(1500);
    expect(parseInputToCents('1.99')).toBe(199);
    expect(parseInputToCents('0.05')).toBe(5);
  });

  it('accepts a leading $ decoration', () => {
    expect(parseInputToCents('$10.50')).toBe(1050);
  });

  it('accepts thousands-separator commas', () => {
    expect(parseInputToCents('1,000.00')).toBe(100_000);
  });

  it('rejects empty / whitespace / nan / negative input', () => {
    expect(parseInputToCents('')).toBeNull();
    expect(parseInputToCents('   ')).toBeNull();
    expect(parseInputToCents('abc')).toBeNull();
    expect(parseInputToCents('-1.00')).toBeNull();
  });

  it('rejects more than two fractional digits', () => {
    expect(parseInputToCents('1.234')).toBeNull();
  });

  it('does not produce float-precision drift', () => {
    expect(parseInputToCents('19.99')).toBe(1999);
    expect(parseInputToCents('0.10')).toBe(10);
    expect(parseInputToCents('0.20')).toBe(20);
  });
});

describe('parseInputToQuantity', () => {
  it('parses positive integer strings', () => {
    expect(parseInputToQuantity('0')).toBe(0);
    expect(parseInputToQuantity('42')).toBe(42);
    expect(parseInputToQuantity('1000')).toBe(1000);
  });

  it('rejects fractional, negative, or non-numeric input', () => {
    expect(parseInputToQuantity('-1')).toBeNull();
    expect(parseInputToQuantity('3.5')).toBeNull();
    expect(parseInputToQuantity('abc')).toBeNull();
    expect(parseInputToQuantity('')).toBeNull();
  });

  it('rejects values over 1,000,000', () => {
    expect(parseInputToQuantity('1000001')).toBeNull();
    expect(parseInputToQuantity('1000000')).toBe(1_000_000);
  });
});

describe('syncStaleness', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('returns "fresh" when synced under an hour ago', () => {
    expect(syncStaleness('2026-05-20T11:30:00.000Z', now)).toBe('fresh');
  });

  it('returns "aging" between 1h and 24h', () => {
    expect(syncStaleness('2026-05-20T08:00:00.000Z', now)).toBe('aging');
  });

  it('returns "stale" past 24h', () => {
    expect(syncStaleness('2026-05-18T12:00:00.000Z', now)).toBe('stale');
  });

  it('returns "never" for null or unparseable input', () => {
    expect(syncStaleness(null, now)).toBe('never');
    expect(syncStaleness('not-a-date', now)).toBe('never');
  });
});

describe('formatSyncedLabel', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('says "Never synced" when null', () => {
    expect(formatSyncedLabel(null, now)).toBe('Never synced');
  });

  it('says "Synced just now" within 90 seconds', () => {
    expect(formatSyncedLabel('2026-05-20T11:59:30.000Z', now)).toBe('Synced just now');
  });

  it('shows minutes inside the first hour', () => {
    expect(formatSyncedLabel('2026-05-20T11:30:00.000Z', now)).toBe('Synced 30m ago');
  });

  it('shows hours between 1h and 24h', () => {
    expect(formatSyncedLabel('2026-05-20T08:00:00.000Z', now)).toBe('Synced 4h ago');
  });

  it('shows days between 1d and 7d', () => {
    expect(formatSyncedLabel('2026-05-18T12:00:00.000Z', now)).toBe('Synced 2d ago');
  });

  it('falls back to a date past 7 days', () => {
    expect(formatSyncedLabel('2026-05-10T12:00:00.000Z', now)).toMatch(/^Synced May 10$/u);
  });
});
