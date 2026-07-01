/**
 * Unit tests for SearchService.
 *
 * SearchService is a thin orchestration layer over
 * `ProductsRepository.searchWithFilters`, but the projection from
 * `Product` → `SearchProductResult` is the only thing keeping internal
 * columns out of the public response. These tests pin:
 *
 *   - Defaults propagate (limit=24, offset=0 when query is empty).
 *   - Filters round-trip into the repo input verbatim.
 *   - The projection drops description, createdAt, updatedAt, deletedAt,
 *     isActive, and searchVector (the internal columns).
 *   - Facet shapes pass through unchanged.
 *   - The page envelope reflects the query's limit/offset (not the repo's,
 *     which already echoed them) — this guarantees the client sees the
 *     same numbers it sent even on an empty result set.
 */
import { describe, expect, it } from 'vitest';
import { SearchService } from './search.service.js';
import type { SearchProductsQuery } from './dto/index.js';
import type { Product, ProductsRepository, StrainType } from '@dankdash/db';

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
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
    searchVector: null,
    createdByDispensaryId: null,
    effectsTags: ['uplifting'],
    flavorTags: ['citrus'],
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

interface FakeSearchInput {
  readonly query?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly strainType?: StrainType | undefined;
  readonly dispensaryId?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

interface FakeSearchPage {
  readonly results: readonly Product[];
  readonly total: number;
  readonly categoryFacets: readonly { readonly categoryId: string; readonly count: number }[];
  readonly strainTypeFacets: readonly {
    readonly strainType: StrainType;
    readonly count: number;
  }[];
}

class FakeProductsRepo implements Pick<ProductsRepository, 'searchWithFilters'> {
  public calls: FakeSearchInput[] = [];
  public next: FakeSearchPage = {
    results: [],
    total: 0,
    categoryFacets: [],
    strainTypeFacets: [],
  };

  searchWithFilters(input: FakeSearchInput): Promise<FakeSearchPage> {
    this.calls.push(input);
    return Promise.resolve(this.next);
  }
}

function makeRig(): { service: SearchService; repo: FakeProductsRepo } {
  const repo = new FakeProductsRepo();
  const service = new SearchService(repo as unknown as ProductsRepository);
  return { service, repo };
}

const EMPTY_QUERY: SearchProductsQuery = { limit: 24, offset: 0 };

describe('SearchService.search', () => {
  it('passes defaults (limit=24, offset=0) through to the repo when no filters are given', async () => {
    const rig = makeRig();

    await rig.service.search(EMPTY_QUERY);

    expect(rig.repo.calls).toEqual([
      {
        query: undefined,
        categoryId: undefined,
        strainType: undefined,
        dispensaryId: undefined,
        limit: 24,
        offset: 0,
      },
    ]);
  });

  it('maps query-string snake_case (strain_type, dispensary_id) to repo camelCase', async () => {
    const rig = makeRig();

    await rig.service.search({
      q: 'sour tangie',
      category: '01935f3d-0000-7000-8000-0000000000a1',
      strain_type: 'sativa',
      dispensary_id: '01935f3d-0000-7000-8000-000000000001',
      limit: 10,
      offset: 20,
    });

    expect(rig.repo.calls[0]).toEqual({
      query: 'sour tangie',
      categoryId: '01935f3d-0000-7000-8000-0000000000a1',
      strainType: 'sativa',
      dispensaryId: '01935f3d-0000-7000-8000-000000000001',
      limit: 10,
      offset: 20,
    });
  });

  it('projects rows into the narrow SearchProductResult shape (no description, no timestamps)', async () => {
    const rig = makeRig();
    rig.repo.next = {
      results: [makeProduct()],
      total: 1,
      categoryFacets: [{ categoryId: '01935f3d-0000-7000-8000-0000000000a1', count: 1 }],
      strainTypeFacets: [{ strainType: 'sativa', count: 1 }],
    };

    const res = await rig.service.search(EMPTY_QUERY);

    expect(res.results).toEqual([
      {
        id: '01935f3d-0000-7000-8000-0000000000d1',
        categoryId: '01935f3d-0000-7000-8000-0000000000a1',
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
      },
    ]);

    // Internal columns are absent (would be present if .strict were dropped).
    const projected = res.results[0] as Record<string, unknown>;
    expect(projected['description']).toBeUndefined();
    expect(projected['searchVector']).toBeUndefined();
    expect(projected['isActive']).toBeUndefined();
    expect(projected['createdAt']).toBeUndefined();
    expect(projected['updatedAt']).toBeUndefined();
    expect(projected['deletedAt']).toBeUndefined();
  });

  it('passes facet rows through unchanged', async () => {
    const rig = makeRig();
    rig.repo.next = {
      results: [],
      total: 0,
      categoryFacets: [
        { categoryId: '01935f3d-0000-7000-8000-0000000000a1', count: 4 },
        { categoryId: '01935f3d-0000-7000-8000-0000000000a2', count: 1 },
      ],
      strainTypeFacets: [
        { strainType: 'sativa', count: 3 },
        { strainType: 'hybrid', count: 2 },
      ],
    };

    const res = await rig.service.search(EMPTY_QUERY);

    expect(res.facets).toEqual({
      categories: [
        { categoryId: '01935f3d-0000-7000-8000-0000000000a1', count: 4 },
        { categoryId: '01935f3d-0000-7000-8000-0000000000a2', count: 1 },
      ],
      strainTypes: [
        { strainType: 'sativa', count: 3 },
        { strainType: 'hybrid', count: 2 },
      ],
    });
  });

  it('echoes the request limit/offset and the repo total in the page envelope', async () => {
    const rig = makeRig();
    rig.repo.next = { results: [], total: 137, categoryFacets: [], strainTypeFacets: [] };

    const res = await rig.service.search({ limit: 10, offset: 80 });

    expect(res.page).toEqual({ limit: 10, offset: 80, total: 137 });
  });

  it('returns the empty envelope stably when no rows match', async () => {
    const rig = makeRig();

    const res = await rig.service.search(EMPTY_QUERY);

    expect(res).toEqual({
      results: [],
      facets: { categories: [], strainTypes: [] },
      page: { limit: 24, offset: 0, total: 0 },
    });
  });

  it('projects multiple rows preserving the order returned by the repo', async () => {
    const rig = makeRig();
    rig.repo.next = {
      results: [
        makeProduct({ id: '01935f3d-0000-7000-8000-0000000000d1', name: 'A' }),
        makeProduct({ id: '01935f3d-0000-7000-8000-0000000000d2', name: 'B' }),
        makeProduct({ id: '01935f3d-0000-7000-8000-0000000000d3', name: 'C' }),
      ],
      total: 3,
      categoryFacets: [],
      strainTypeFacets: [],
    };

    const res = await rig.service.search(EMPTY_QUERY);

    expect(res.results.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });
});
