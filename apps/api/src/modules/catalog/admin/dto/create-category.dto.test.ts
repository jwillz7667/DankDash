/**
 * Unit tests for CreateCategoryRequestSchema.
 *
 * Behaviours pinned:
 *   - Slug shape: kebab-case lowercase + digits + hyphen, no leading/trailing
 *     hyphen, no spaces. Anything else is rejected at the schema so the
 *     public read endpoint never has to defend against a malformed slug
 *     surfacing into URLs.
 *   - displayName / iconKey length limits.
 *   - parentId optionality + null acceptance (top-level categories carry NULL).
 *   - displayOrder optional (DB default 0 applies when omitted) and bounded.
 *   - Strict: unknown top-level fields rejected (typo guard + future-widening
 *     guard).
 */
import { describe, expect, it } from 'vitest';
import { CreateCategoryRequestSchema } from './create-category.dto.js';

describe('CreateCategoryRequestSchema', () => {
  it('parses a minimal valid create body (top-level category)', () => {
    const parsed = CreateCategoryRequestSchema.parse({
      slug: 'flower',
      displayName: 'Flower',
    });
    expect(parsed.slug).toBe('flower');
    expect(parsed.displayName).toBe('Flower');
    expect(parsed.parentId).toBeUndefined();
    expect(parsed.displayOrder).toBeUndefined();
  });

  it('accepts every optional field including nullable parentId', () => {
    const parsed = CreateCategoryRequestSchema.parse({
      slug: 'vape-cart',
      displayName: 'Vape carts',
      parentId: '01935f3d-0000-7000-8000-000000000005',
      displayOrder: 3,
      iconKey: 'icons/vape.png',
    });
    expect(parsed.parentId).toBe('01935f3d-0000-7000-8000-000000000005');
    expect(parsed.displayOrder).toBe(3);
  });

  it('accepts parentId as explicit null (top-level node)', () => {
    const parsed = CreateCategoryRequestSchema.parse({
      slug: 'flower',
      displayName: 'Flower',
      parentId: null,
    });
    expect(parsed.parentId).toBeNull();
  });

  it.each([
    ['Flower', 'uppercase letters'],
    ['flower!', 'punctuation'],
    ['flower category', 'spaces'],
    ['-flower', 'leading hyphen'],
    ['flower-', 'trailing hyphen'],
    ['a', 'too short'],
  ])('rejects slug %s (%s)', (slug) => {
    expect(() => CreateCategoryRequestSchema.parse({ slug, displayName: 'X' })).toThrow();
  });

  it('rejects unknown top-level fields (typo guard via .strict)', () => {
    expect(() =>
      CreateCategoryRequestSchema.parse({
        slug: 'flower',
        displayName: 'Flower',
        nonsense: true,
      }),
    ).toThrow();
  });

  it('rejects an empty displayName', () => {
    expect(() => CreateCategoryRequestSchema.parse({ slug: 'flower', displayName: '' })).toThrow();
  });

  it('rejects a non-uuid parentId', () => {
    expect(() =>
      CreateCategoryRequestSchema.parse({
        slug: 'flower',
        displayName: 'Flower',
        parentId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('rejects a negative displayOrder', () => {
    expect(() =>
      CreateCategoryRequestSchema.parse({
        slug: 'flower',
        displayName: 'Flower',
        displayOrder: -1,
      }),
    ).toThrow();
  });

  it('rejects a non-integer displayOrder', () => {
    expect(() =>
      CreateCategoryRequestSchema.parse({
        slug: 'flower',
        displayName: 'Flower',
        displayOrder: 1.5,
      }),
    ).toThrow();
  });
});
