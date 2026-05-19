/**
 * Time-freezing helpers for tests that exercise compliance hours, schedule
 * windows, or anything that branches on `new Date()` / `Date.now()`.
 *
 * Wraps vitest's `vi.useFakeTimers` / `vi.setSystemTime` so a test can write:
 *
 *   beforeEach(() => freezeTime('2026-02-14T14:30:00-06:00')); // valentine, MN PM
 *   afterEach(() => unfreezeTime());
 *
 * The CLAUDE.md non-negotiables require business-hour logic to honor
 * America/Chicago; the literal IANA zone is exported here for callers that
 * derive their own anchors.
 */
import { vi } from 'vitest';

export const MN_TIMEZONE = 'America/Chicago';

class InvalidDateInputError extends Error {
  public override readonly name = 'InvalidDateInputError';
  constructor(input: unknown) {
    super(`freezeTime: invalid date input ${String(input)}`);
  }
}

export function freezeTime(at: Date | string): Date {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidDateInputError(at);
  }
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(date);
  return date;
}

export function unfreezeTime(): void {
  vi.useRealTimers();
}

/**
 * Advance the fake clock by `ms`. No-op if `freezeTime` was not called.
 */
export function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}
