/**
 * Unit tests for the reset-code primitives.
 *
 * These are pure functions over CSPRNG bytes + SHA-256, so the tests assert
 * three contracts the service leans on:
 *
 *   1. `generateResetCode` only ever emits Crockford-base32 symbols, in the
 *      canonical 12-char / displayed `XXXX-XXXX-XXXX` shapes, and the display
 *      form is exactly the canonical form re-grouped (no information added or
 *      lost beyond the separators).
 *   2. `normalizeResetCode` folds the transcription mistakes Crockford was
 *      designed to absorb (case, spacing, hyphens, O→0, I/L→1) and is
 *      idempotent — and crucially that `normalize(display) === canonical`, the
 *      exact round-trip `resetPassword` performs before hashing.
 *   3. `hashResetCode` is a deterministic 32-byte digest, sensitive to its
 *      input, so a stored hash uniquely pins a code.
 */
import { describe, expect, it } from 'vitest';
import { generateResetCode, hashResetCode, normalizeResetCode } from './reset-code.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/u;
const DISPLAY_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u;

describe('generateResetCode', () => {
  it('emits a 12-symbol canonical code drawn only from the Crockford alphabet', () => {
    const { canonical } = generateResetCode();

    expect(canonical).toHaveLength(12);
    expect(canonical).toMatch(CROCKFORD);
    // Crockford omits I, L, O, U specifically so the code never contains a
    // symbol that confuses with 0/1 — verify none leak in.
    expect(canonical).not.toMatch(/[ILOU]/u);
  });

  it('formats the display code as three hyphen-separated groups of four', () => {
    const { display } = generateResetCode();

    expect(display).toMatch(DISPLAY_SHAPE);
    expect(display).toHaveLength(14); // 12 symbols + 2 hyphens
  });

  it('display is exactly the canonical code re-grouped — strip hyphens to recover it', () => {
    const { canonical, display } = generateResetCode();

    expect(display.replace(/-/gu, '')).toBe(canonical);
  });

  it('does not repeat across many draws (60 bits of entropy)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const { canonical } = generateResetCode();
      expect(canonical).toHaveLength(12);
      seen.add(canonical);
    }
    // A collision in 1000 draws from a 2^60 space is astronomically unlikely;
    // a duplicate here means the generator lost entropy (e.g. a constant seed).
    expect(seen.size).toBe(1_000);
  });
});

describe('normalizeResetCode', () => {
  it('uppercases, trims, and strips spaces and hyphens', () => {
    expect(normalizeResetCode('  ab cd-ef  ')).toBe('ABCDEF');
    expect(normalizeResetCode('a-b-c-d')).toBe('ABCD');
    expect(normalizeResetCode('AB\tCD\nEF')).toBe('ABCDEF');
  });

  it('maps the confusable glyphs Crockford reserves (O→0, I→1, L→1)', () => {
    expect(normalizeResetCode('O')).toBe('0');
    expect(normalizeResetCode('I')).toBe('1');
    expect(normalizeResetCode('L')).toBe('1');
    expect(normalizeResetCode('o0iIlL')).toBe('001111');
  });

  it('is idempotent', () => {
    const messy = ' 0o1i-Lk9z ';
    const once = normalizeResetCode(messy);
    expect(normalizeResetCode(once)).toBe(once);
  });

  it('recovers the canonical code from its displayed form (the reset round-trip)', () => {
    for (let i = 0; i < 100; i += 1) {
      const { canonical, display } = generateResetCode();
      // The display form only adds hyphens, and a canonical code never
      // contains O/I/L/U, so normalization must reproduce it byte-for-byte.
      expect(normalizeResetCode(display)).toBe(canonical);
      // Lower-cased, spaced rendering a human might type back also folds home.
      expect(normalizeResetCode(display.toLowerCase().replace(/-/gu, ' '))).toBe(canonical);
    }
  });
});

describe('hashResetCode', () => {
  it('produces a deterministic 32-byte SHA-256 digest', () => {
    const a = hashResetCode('ABCDEF012345');
    const b = hashResetCode('ABCDEF012345');

    expect(a).toHaveLength(32);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('is sensitive to its input — a one-symbol change flips the digest', () => {
    const a = hashResetCode('ABCDEF012345');
    const b = hashResetCode('ABCDEF012346');

    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('hashing canonical equals hashing the normalized display form', () => {
    const { canonical, display } = generateResetCode();

    expect(
      Buffer.compare(hashResetCode(canonical), hashResetCode(normalizeResetCode(display))),
    ).toBe(0);
  });
});
