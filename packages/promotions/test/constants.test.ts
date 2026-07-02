import { describe, expect, it } from 'vitest';
import { normalizePromoCode } from '../src/constants.js';

describe('normalizePromoCode', () => {
  it('uppercases and trims surrounding whitespace', () => {
    expect(normalizePromoCode('  save10 ')).toBe('SAVE10');
  });

  it('leaves an already-canonical code unchanged', () => {
    expect(normalizePromoCode('SAVE10')).toBe('SAVE10');
  });
});
