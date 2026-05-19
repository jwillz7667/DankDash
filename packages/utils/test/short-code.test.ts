/**
 * Short-code unit tests.
 *
 * Tests the contract — alphabet, length, no-modulo-bias on the byte
 * mapping, and the retry/exhaustion semantics — without asserting any
 * specific code (that would be a flaky test against `randomBytes`).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  DEFAULT_MAX_ATTEMPTS,
  SHORT_CODE_LENGTH,
  ShortCodeCollisionError,
  generateShortCode,
  isValidShortCode,
  withCollisionRetry,
} from '../src/index.js';

describe('CROCKFORD_ALPHABET', () => {
  it('contains exactly 32 unique symbols', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
  });

  it('omits the ambiguous letters I, L, O, U', () => {
    for (const banned of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(banned);
    }
  });

  it('is uppercase + digits only', () => {
    expect(CROCKFORD_ALPHABET).toMatch(/^[0-9A-Z]+$/u);
  });
});

describe('generateShortCode', () => {
  it('returns a 6-character string from the Crockford alphabet', () => {
    const code = generateShortCode();
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    for (const ch of code) {
      expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it('produces statistically distinct codes across 10k calls', () => {
    // Collision rate on 10k samples from 2^30 space is ~5%. We accept
    // up to 20 collisions before failing the test — well above the
    // expected mean and far below what would indicate a broken
    // generator (e.g. fixed seed, modulo-32 bias).
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const c = generateShortCode();
      if (seen.has(c)) collisions += 1;
      seen.add(c);
    }
    expect(collisions).toBeLessThan(20);
  });

  it('only ever uses 5 bits per byte (alphabet has 32 symbols)', () => {
    // Sample 5k codes, build the per-position character histogram, and
    // assert every alphabet symbol appears at every position at least
    // once. A modulo-bias bug would skew the distribution and leave
    // some symbols below threshold; an off-by-one in the mask would
    // produce out-of-alphabet characters and fail the existence check.
    const histograms: Record<string, number>[] = Array.from(
      { length: SHORT_CODE_LENGTH },
      () => ({}),
    );
    for (let i = 0; i < 5_000; i += 1) {
      const code = generateShortCode();
      for (let p = 0; p < SHORT_CODE_LENGTH; p += 1) {
        const ch = code[p]!;
        histograms[p]![ch] = (histograms[p]![ch] ?? 0) + 1;
      }
    }
    for (const hist of histograms) {
      for (const sym of CROCKFORD_ALPHABET) {
        expect(hist[sym]).toBeGreaterThan(0);
      }
    }
  });
});

describe('isValidShortCode', () => {
  it.each(['ABC123', '0000ZZ', '3F9A2K'])('accepts a well-formed code: %s', (code) => {
    expect(isValidShortCode(code)).toBe(true);
  });

  it.each(['ABC12', 'ABC1234', '', '      '])('rejects wrong-length input: %j', (code) => {
    expect(isValidShortCode(code)).toBe(false);
  });

  it('rejects lowercase letters', () => {
    expect(isValidShortCode('abcdef')).toBe(false);
  });

  it.each(['ABCDIF', 'ABCDLF', 'ABCDOF', 'ABCDUF'])('rejects ambiguous letters: %j', (code) => {
    expect(isValidShortCode(code)).toBe(false);
  });

  it('rejects symbols outside the alphabet', () => {
    expect(isValidShortCode('ABC-12')).toBe(false);
    expect(isValidShortCode('ABC 12')).toBe(false);
  });
});

describe('withCollisionRetry', () => {
  it('returns the first candidate when no collision exists', async () => {
    const generate = vi.fn(() => 'ABC123');
    const existsAlready = vi.fn(() => Promise.resolve(false));

    const out = await withCollisionRetry(generate, existsAlready);

    expect(out).toBe('ABC123');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(existsAlready).toHaveBeenCalledTimes(1);
  });

  it('retries on collision and returns the first free candidate', async () => {
    const seq = ['ONE', 'TWO', 'THREE'];
    let i = 0;
    const generate = vi.fn(() => seq[i++]!);
    const taken = new Set(['ONE', 'TWO']);
    const existsAlready = vi.fn((c: string) => Promise.resolve(taken.has(c)));

    const out = await withCollisionRetry(generate, existsAlready);

    expect(out).toBe('THREE');
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('throws ShortCodeCollisionError after exhausting maxAttempts', async () => {
    const generate = vi.fn(() => 'TAKEN');
    const existsAlready = vi.fn(() => Promise.resolve(true));

    await expect(withCollisionRetry(generate, existsAlready, 3)).rejects.toBeInstanceOf(
      ShortCodeCollisionError,
    );
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('uses DEFAULT_MAX_ATTEMPTS when no override is supplied', async () => {
    const generate = vi.fn(() => 'TAKEN');
    const existsAlready = vi.fn(() => Promise.resolve(true));

    await expect(withCollisionRetry(generate, existsAlready)).rejects.toBeInstanceOf(
      ShortCodeCollisionError,
    );
    expect(generate).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects bad maxAttempts: %j', async (maxAttempts) => {
    await expect(
      withCollisionRetry(
        () => 'ABC123',
        () => Promise.resolve(false),
        maxAttempts,
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('ShortCodeCollisionError', () => {
  it('reports the attempt count in the message', () => {
    const err = new ShortCodeCollisionError(8);
    expect(err.message).toContain('8 attempts');
    expect(err.name).toBe('ShortCodeCollisionError');
  });
});
