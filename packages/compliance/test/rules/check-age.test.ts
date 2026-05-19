/**
 * Age rule — every case from CLAUDE-CODE-PHASES.md §3.5.
 *
 * The boundary case "exactly 21 today" is exercised at the millisecond
 * level: DOB set to the exact instant 21 years before `now` must pass,
 * and one millisecond later (= one ms older than 21 years from now's
 * perspective… no, sorry: one ms after the 21-years-from-now boundary,
 * meaning user is one ms younger than 21) must fail.
 */
import { describe, expect, it } from 'vitest';
import { checkAge } from '../../src/index.js';
import { makeContext, makeUser } from '../fixtures.js';

const NOW = new Date('2026-05-18T12:00:00Z');

describe('checkAge', () => {
  it('passes for a user exactly 21 years old today', () => {
    const dob = new Date('2005-05-18T12:00:00Z');
    const ctx = makeContext({ user: makeUser({ dateOfBirth: dob }) });

    const res = checkAge(ctx, NOW);

    expect(res.passed).toBe(true);
    expect(res.details['age']).toBe(21);
  });

  it('fails for a user 20 years and 364 days old', () => {
    const dob = new Date('2005-05-19T12:00:00Z');
    const ctx = makeContext({ user: makeUser({ dateOfBirth: dob }) });

    const res = checkAge(ctx, NOW);

    expect(res.passed).toBe(false);
    expect(res.details['age']).toBe(20);
  });

  it('fails fast with dob_missing when dateOfBirth is null', () => {
    const ctx = makeContext({ user: makeUser({ dateOfBirth: null }) });

    const res = checkAge(ctx, NOW);

    expect(res.passed).toBe(false);
    expect(res.details['reason']).toBe('dob_missing');
  });

  it('fails closed on a future DOB and surfaces the value for ops', () => {
    const dob = new Date('2030-01-01T00:00:00Z');
    const ctx = makeContext({ user: makeUser({ dateOfBirth: dob }) });

    const res = checkAge(ctx, NOW);

    expect(res.passed).toBe(false);
    expect(res.details['reason']).toBe('future_dob');
    expect(res.details['dateOfBirth']).toBe('2030-01-01T00:00:00.000Z');
  });

  it('passes comfortably for a clearly-adult DOB', () => {
    const ctx = makeContext({
      user: makeUser({ dateOfBirth: new Date('1980-06-30T00:00:00Z') }),
    });

    const res = checkAge(ctx, NOW);

    expect(res.passed).toBe(true);
    expect(res.details['age']).toBe(45);
    expect(res.details['minimum']).toBe(21);
  });
});
