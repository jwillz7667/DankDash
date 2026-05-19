/**
 * Catalog DTO tests. Schemas are exercised directly without crossing the
 * Nest pipeline — that pipeline is covered separately in
 * common/pipes/zod-validation.pipe.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { CategoryListResponseSchema, CategoryResponseSchema } from './category.dto.js';
import {
  LabResultResponseSchema,
  ProductResponseSchema,
  ProductTypeSchema,
  StrainTypeSchema,
} from './product.dto.js';

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

describe('ProductTypeSchema', () => {
  it('accepts every product_type enum value', () => {
    const allTypes = [
      'flower',
      'preroll',
      'infused_preroll',
      'vape',
      'edible',
      'beverage',
      'concentrate',
      'tincture',
      'topical',
      'accessory',
      'seed',
      'clone',
    ];
    for (const t of allTypes) {
      expect(() => ProductTypeSchema.parse(t)).not.toThrow();
    }
  });

  it('rejects an unknown product type', () => {
    expect(() => ProductTypeSchema.parse('mushroom')).toThrow();
  });
});

describe('StrainTypeSchema', () => {
  it('accepts every strain_type enum value', () => {
    for (const t of ['indica', 'sativa', 'hybrid', 'cbd', 'balanced']) {
      expect(() => StrainTypeSchema.parse(t)).not.toThrow();
    }
  });

  it('rejects an unknown strain type', () => {
    expect(() => StrainTypeSchema.parse('ruderalis')).toThrow();
  });
});

describe('LabResultResponseSchema', () => {
  const sample = {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    batchId: 'BATCH-2026-05-01',
    labName: 'Northland Labs',
    coaDocumentKey: 'coas/2026/05/batch-2026-05-01.pdf',
    potencyThc: '24.500',
    potencyCbd: '0.100',
    contaminantsPassed: true,
    testedAt: '2026-04-28',
  } as const;

  it('accepts a complete lab result', () => {
    expect(() => LabResultResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts nulls for un-tested fields (potency, contaminants, coa key)', () => {
    expect(() =>
      LabResultResponseSchema.parse({
        ...sample,
        coaDocumentKey: null,
        potencyThc: null,
        potencyCbd: null,
        contaminantsPassed: null,
      }),
    ).not.toThrow();
  });

  it('rejects an ISO-datetime testedAt (must be YYYY-MM-DD date-only)', () => {
    expect(() =>
      LabResultResponseSchema.parse({ ...sample, testedAt: '2026-04-28T00:00:00.000Z' }),
    ).toThrow();
  });

  it('rejects a non-decimal potency string (e.g. embedded units)', () => {
    expect(() => LabResultResponseSchema.parse({ ...sample, potencyThc: '24mg' })).toThrow();
  });
});

describe('ProductResponseSchema', () => {
  const sample = {
    id: '01935f3d-0000-7000-8000-000000000001',
    categoryId: '01935f3d-0000-7000-8000-0000000000a1',
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
    description: 'A bright sativa-dominant hybrid with a citrus nose.',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '24.500',
    cbdMgPerUnit: '0.100',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: ['products/sunny-side/sour-tangie/01.jpg'],
    effectsTags: ['uplifting'],
    flavorTags: ['citrus'],
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    labResults: [],
  } as const;

  it('accepts a complete product', () => {
    expect(() => ProductResponseSchema.parse(sample)).not.toThrow();
  });

  it('accepts beverage-specific serving fields', () => {
    expect(() =>
      ProductResponseSchema.parse({
        ...sample,
        productType: 'beverage',
        strainType: null,
        servingCount: 2,
        thcMgPerServing: '5.000',
      }),
    ).not.toThrow();
  });

  it('accepts a null strainType for accessories', () => {
    expect(() =>
      ProductResponseSchema.parse({
        ...sample,
        productType: 'accessory',
        strainType: null,
      }),
    ).not.toThrow();
  });

  it('rejects internal columns surfacing in the response (isActive, searchVector, deletedAt)', () => {
    expect(() => ProductResponseSchema.parse({ ...sample, isActive: true })).toThrow();
    expect(() => ProductResponseSchema.parse({ ...sample, searchVector: 'foo:1' })).toThrow();
    expect(() => ProductResponseSchema.parse({ ...sample, deletedAt: null })).toThrow();
  });

  it('rejects a JS-number thcMgPerUnit (numerics must be strings to preserve precision)', () => {
    expect(() => ProductResponseSchema.parse({ ...sample, thcMgPerUnit: 24.5 })).toThrow();
  });
});
