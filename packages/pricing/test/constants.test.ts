/**
 * Constants — taxability matrix.
 *
 * These tests pin the cannabis-tax classification for every
 * `ProductType` value. If the catalog enum gains a new value, the type
 * checker will not catch a missing case here — only this exhaustive
 * matrix will — so do not collapse it into a single parametric assert.
 */
import { describe, expect, it } from 'vitest';
import { isCannabisTaxable } from '../src/index.js';
import type { ProductType } from '@dankdash/compliance';

describe('isCannabisTaxable — per-type matrix', () => {
  it.each<[ProductType, boolean]>([
    ['flower', true],
    ['preroll', true],
    ['infused_preroll', true],
    ['vape', true],
    ['concentrate', true],
    ['edible', true],
    ['beverage', true],
    ['tincture', true],
    ['topical', true],
    ['seed', true],
    ['clone', true],
    ['accessory', false],
  ])('%s -> %s', (productType, expected) => {
    expect(isCannabisTaxable(productType)).toBe(expected);
  });
});
