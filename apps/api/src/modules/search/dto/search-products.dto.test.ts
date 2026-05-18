/**
 * Unit tests for search DTOs.
 *
 * These contracts are the only thing protecting the iOS/web clients from
 * silent field renames or accidental column leaks via a future migration.
 * Behaviour worth pinning:
 *
 *   - All query params are optional and coerced from strings (Fastify
 *     hands query values in as strings before Zod runs).
 *   - `limit`/`offset` have safe defaults (24 / 0) so unfiltered browsing
 *     "just works" with `GET /v1/products/search` and nothing else.
 *   - Internal product columns (description, searchVector, isActive,
 *     deletedAt, createdAt, updatedAt) are rejected on the response side.
 *   - Facet shapes are strict so a future widening cannot leak data.
 */
import { describe, expect, it } from 'vitest';
import {
  SearchFacetCategorySchema,
  SearchFacetStrainTypeSchema,
  SearchPageSchema,
  SearchProductResultSchema,
  SearchProductsQuerySchema,
  SearchProductsResponseSchema,
} from './search-products.dto.js';

const VALID_UUID_A = '01935f3d-0000-7000-8000-0000000000a1';
const VALID_UUID_B = '01935f3d-0000-7000-8000-0000000000b1';
const VALID_UUID_C = '01935f3d-0000-7000-8000-0000000000c1';

describe('SearchProductsQuerySchema', () => {
  it('parses an empty query to defaults (limit=24, offset=0, no filters)', () => {
    const parsed = SearchProductsQuerySchema.parse({});

    expect(parsed).toEqual({ limit: 24, offset: 0 });
    expect(parsed.q).toBeUndefined();
    expect(parsed.category).toBeUndefined();
    expect(parsed.strain_type).toBeUndefined();
    expect(parsed.dispensary_id).toBeUndefined();
  });

  it('coerces numeric strings for limit and offset (Fastify hands them in as strings)', () => {
    const parsed = SearchProductsQuerySchema.parse({ limit: '10', offset: '40' });

    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(40);
  });

  it('trims and accepts a typical websearch query', () => {
    const parsed = SearchProductsQuerySchema.parse({ q: '  sour tangie  ' });

    expect(parsed.q).toBe('sour tangie');
  });

  it('rejects an empty-after-trim query (would match everything)', () => {
    expect(() => SearchProductsQuerySchema.parse({ q: '   ' })).toThrow();
  });

  it('rejects q longer than 200 characters (DoS guard on the tsquery parse)', () => {
    expect(() => SearchProductsQuerySchema.parse({ q: 'a'.repeat(201) })).toThrow();
  });

  it('accepts every canonical strain_type enum value', () => {
    for (const strain of ['indica', 'sativa', 'hybrid', 'cbd', 'balanced'] as const) {
      expect(SearchProductsQuerySchema.parse({ strain_type: strain }).strain_type).toBe(strain);
    }
  });

  it('rejects a non-enum strain_type', () => {
    expect(() => SearchProductsQuerySchema.parse({ strain_type: 'kush' })).toThrow();
  });

  it('rejects a non-UUID category', () => {
    expect(() => SearchProductsQuerySchema.parse({ category: 'flower' })).toThrow();
  });

  it('rejects a non-UUID dispensary_id', () => {
    expect(() => SearchProductsQuerySchema.parse({ dispensary_id: 'abc' })).toThrow();
  });

  it('clamps limit at the upper bound (50)', () => {
    expect(() => SearchProductsQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('rejects limit below 1', () => {
    expect(() => SearchProductsQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => SearchProductsQuerySchema.parse({ offset: -1 })).toThrow();
  });

  it('rejects non-integer limit/offset (decimals would tear pages)', () => {
    expect(() => SearchProductsQuerySchema.parse({ limit: 10.5 })).toThrow();
    expect(() => SearchProductsQuerySchema.parse({ offset: 5.5 })).toThrow();
  });

  it('rejects unknown query parameters (typo guard via .strict())', () => {
    expect(() => SearchProductsQuerySchema.parse({ q: 'foo', dispensary: VALID_UUID_A })).toThrow();
  });
});

describe('SearchProductResultSchema', () => {
  const VALID: Record<string, unknown> = {
    id: VALID_UUID_A,
    categoryId: VALID_UUID_B,
    brand: 'Sunny Side',
    name: 'Sour Tangie 3.5g',
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
  };

  it('accepts a fully populated, valid product result', () => {
    expect(SearchProductResultSchema.parse(VALID)).toEqual(VALID);
  });

  it('accepts servingCount/thcMgPerServing on an edible-shaped result', () => {
    const edible = { ...VALID, productType: 'edible', servingCount: 10, thcMgPerServing: '5.000' };
    expect(SearchProductResultSchema.parse(edible)).toMatchObject({
      servingCount: 10,
      thcMgPerServing: '5.000',
    });
  });

  it('accepts a null strainType (accessories, seeds, topicals)', () => {
    expect(
      SearchProductResultSchema.parse({ ...VALID, strainType: null, productType: 'accessory' })
        .strainType,
    ).toBeNull();
  });

  it('rejects a non-decimal thcMgPerUnit (would break Decimal parsing on the client)', () => {
    expect(() => SearchProductResultSchema.parse({ ...VALID, thcMgPerUnit: '24.5mg' })).toThrow();
  });

  it.each([
    ['description', 'leaks copy intended for the detail screen'],
    ['createdAt', 'internal timestamp'],
    ['updatedAt', 'internal timestamp'],
    ['deletedAt', 'tombstone marker'],
    ['isActive', 'admin flag'],
    ['searchVector', 'tsvector text leak'],
    ['labResults', 'pulls in lab COA payload — detail-screen only'],
  ])('rejects extra field "%s" (%s)', (extra) => {
    expect(() => SearchProductResultSchema.parse({ ...VALID, [extra]: 'whatever' })).toThrow();
  });
});

describe('SearchFacetCategorySchema', () => {
  it('accepts a categoryId/count pair', () => {
    expect(SearchFacetCategorySchema.parse({ categoryId: VALID_UUID_A, count: 12 })).toEqual({
      categoryId: VALID_UUID_A,
      count: 12,
    });
  });

  it('rejects a negative count', () => {
    expect(() =>
      SearchFacetCategorySchema.parse({ categoryId: VALID_UUID_A, count: -1 }),
    ).toThrow();
  });

  it('rejects a non-UUID categoryId', () => {
    expect(() => SearchFacetCategorySchema.parse({ categoryId: 'flower', count: 1 })).toThrow();
  });
});

describe('SearchFacetStrainTypeSchema', () => {
  it('accepts a strain enum and a non-negative count', () => {
    expect(SearchFacetStrainTypeSchema.parse({ strainType: 'sativa', count: 3 })).toEqual({
      strainType: 'sativa',
      count: 3,
    });
  });

  it('rejects a null strainType (facet rows for null are dropped server-side)', () => {
    expect(() => SearchFacetStrainTypeSchema.parse({ strainType: null, count: 1 })).toThrow();
  });
});

describe('SearchPageSchema', () => {
  it('accepts a valid page envelope', () => {
    expect(SearchPageSchema.parse({ limit: 24, offset: 0, total: 100 })).toEqual({
      limit: 24,
      offset: 0,
      total: 100,
    });
  });

  it('rejects a total of -1 (invariant: count is non-negative)', () => {
    expect(() => SearchPageSchema.parse({ limit: 10, offset: 0, total: -1 })).toThrow();
  });

  it('rejects a limit > 50 (mirrors the query upper bound)', () => {
    expect(() => SearchPageSchema.parse({ limit: 51, offset: 0, total: 0 })).toThrow();
  });
});

describe('SearchProductsResponseSchema', () => {
  it('accepts the empty-results envelope (no results, no facet rows, total=0)', () => {
    const empty = {
      results: [],
      facets: { categories: [], strainTypes: [] },
      page: { limit: 24, offset: 0, total: 0 },
    };
    expect(SearchProductsResponseSchema.parse(empty)).toEqual(empty);
  });

  it('accepts a populated envelope and rejects extras at every level', () => {
    const full = {
      results: [
        {
          id: VALID_UUID_A,
          categoryId: VALID_UUID_B,
          brand: 'Sunny Side',
          name: 'Sour Tangie 3.5g',
          productType: 'flower' as const,
          strainType: 'sativa' as const,
          thcMgPerUnit: '24.500',
          cbdMgPerUnit: '0.100',
          weightGramsPerUnit: '3.500',
          servingCount: null,
          thcMgPerServing: null,
          imageKeys: ['products/sunny-side/sour-tangie/01.jpg'],
          effectsTags: ['uplifting'],
          flavorTags: ['citrus'],
        },
      ],
      facets: {
        categories: [{ categoryId: VALID_UUID_C, count: 1 }],
        strainTypes: [{ strainType: 'sativa' as const, count: 1 }],
      },
      page: { limit: 24, offset: 0, total: 1 },
    };
    expect(SearchProductsResponseSchema.parse(full)).toEqual(full);
    expect(() => SearchProductsResponseSchema.parse({ ...full, debug: 'oops' })).toThrow();
  });
});
