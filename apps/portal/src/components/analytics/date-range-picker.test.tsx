import { describe, expect, it } from 'vitest';
import { resolveWindowFromSearchParams } from './date-range-picker.js';

describe('resolveWindowFromSearchParams', () => {
  it('falls back to a 7-day window when no params are present', () => {
    const now = new Date('2026-05-20T12:34:56.789Z');
    const { from, to } = resolveWindowFromSearchParams({}, now);
    // `to` is tomorrow's UTC midnight so the partial day is included.
    expect(to).toBe('2026-05-21T00:00:00.000Z');
    // `from` is 7 days back from `to`.
    expect(from).toBe('2026-05-14T00:00:00.000Z');
  });

  it('returns the URL window when valid ISO timestamps are supplied', () => {
    const now = new Date('2026-05-20T12:00:00.000Z');
    const { from, to } = resolveWindowFromSearchParams(
      { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
      now,
    );
    expect(from).toBe('2026-04-01T00:00:00.000Z');
    expect(to).toBe('2026-05-01T00:00:00.000Z');
  });

  it('falls back to the default window when from is not ISO-Z', () => {
    const now = new Date('2026-05-20T12:00:00.000Z');
    const { from, to } = resolveWindowFromSearchParams(
      { from: 'not-a-date', to: '2026-05-01T00:00:00.000Z' },
      now,
    );
    expect(to).toBe('2026-05-21T00:00:00.000Z');
    expect(from).toBe('2026-05-14T00:00:00.000Z');
  });

  it('ignores array-form params (Next.js shape)', () => {
    const now = new Date('2026-05-20T12:00:00.000Z');
    const { from, to } = resolveWindowFromSearchParams(
      { from: ['2026-05-01T00:00:00.000Z'], to: '2026-05-10T00:00:00.000Z' },
      now,
    );
    // from was an array, so falls back to the default window
    expect(from).toBe('2026-05-14T00:00:00.000Z');
    expect(to).toBe('2026-05-21T00:00:00.000Z');
  });
});
