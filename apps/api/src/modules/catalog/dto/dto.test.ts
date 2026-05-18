/**
 * Catalog DTO tests. Schemas are exercised directly without crossing the
 * Nest pipeline — that pipeline is covered separately in
 * common/pipes/zod-validation.pipe.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { CategoryListResponseSchema, CategoryResponseSchema } from './category.dto.js';

describe('CategoryResponseSchema', () => {
  const sample = {
    id: '01935f3d-0000-7000-8000-000000000001',
    slug: 'flower',
    displayName: 'Flower',
    parentId: null,
    displayOrder: 0,
    iconKey: 'icons/flower.png',
  } as const;

  it('accepts a complete category', () => {
    expect(() => CategoryResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts a null iconKey for un-themed categories', () => {
    expect(() => CategoryResponseSchema.parse({ ...sample, iconKey: null })).not.toThrow();
  });

  it('accepts a populated parentId for subcategories', () => {
    expect(() =>
      CategoryResponseSchema.parse({
        ...sample,
        parentId: '01935f3d-0000-7000-8000-000000000002',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown field (strict mode preserves the response contract)', () => {
    expect(() => CategoryResponseSchema.parse({ ...sample, sortOrder: 5 })).toThrow();
  });

  it('rejects a non-uuid id', () => {
    expect(() => CategoryResponseSchema.parse({ ...sample, id: 'not-a-uuid' })).toThrow();
  });

  it('rejects a non-integer displayOrder', () => {
    expect(() => CategoryResponseSchema.parse({ ...sample, displayOrder: 1.5 })).toThrow();
  });
});

describe('CategoryListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(() => CategoryListResponseSchema.parse({ categories: [] })).not.toThrow();
  });

  it('accepts a list of valid categories', () => {
    const parsed = CategoryListResponseSchema.parse({
      categories: [
        {
          id: '01935f3d-0000-7000-8000-000000000001',
          slug: 'flower',
          displayName: 'Flower',
          parentId: null,
          displayOrder: 0,
          iconKey: null,
        },
      ],
    });
    expect(parsed.categories).toHaveLength(1);
  });

  it('rejects unknown top-level fields', () => {
    expect(() => CategoryListResponseSchema.parse({ categories: [], page: 1 })).toThrow();
  });
});
