/**
 * Unit tests for SearchController.
 *
 * The controller is a thin pass-through to SearchService; the test pins
 * that the query is forwarded verbatim and the response is returned
 * unwrapped (no envelope rewriting at the HTTP boundary — the response
 * shape is already a complete envelope owned by the DTO).
 */
import { describe, expect, it } from 'vitest';
import { SearchController } from './search.controller.js';
import type { SearchProductsQuery, SearchProductsResponse } from './dto/index.js';
import type { SearchService } from './search.service.js';

const EMPTY_RESPONSE: SearchProductsResponse = {
  results: [],
  facets: { categories: [], strainTypes: [] },
  page: { limit: 24, offset: 0, total: 0 },
};

const POPULATED_RESPONSE: SearchProductsResponse = {
  results: [
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
  ],
  facets: {
    categories: [{ categoryId: '01935f3d-0000-7000-8000-0000000000a1', count: 1 }],
    strainTypes: [{ strainType: 'sativa', count: 1 }],
  },
  page: { limit: 24, offset: 0, total: 1 },
};

class FakeSearchService {
  public calls: SearchProductsQuery[] = [];
  public next: SearchProductsResponse = EMPTY_RESPONSE;

  search = (q: SearchProductsQuery): Promise<SearchProductsResponse> => {
    this.calls.push(q);
    return Promise.resolve(this.next);
  };
}

describe('SearchController.searchProducts', () => {
  it('forwards the (defaulted) query to SearchService and returns the response unchanged', async () => {
    const svc = new FakeSearchService();
    svc.next = POPULATED_RESPONSE;
    const controller = new SearchController(svc as unknown as SearchService);

    const res = await controller.searchProducts({ limit: 24, offset: 0 });

    expect(res).toEqual(POPULATED_RESPONSE);
    expect(svc.calls).toEqual([{ limit: 24, offset: 0 }]);
  });

  it('forwards all filter parameters verbatim', async () => {
    const svc = new FakeSearchService();
    const controller = new SearchController(svc as unknown as SearchService);

    await controller.searchProducts({
      q: 'sour tangie',
      category: '01935f3d-0000-7000-8000-0000000000a1',
      strain_type: 'sativa',
      dispensary_id: '01935f3d-0000-7000-8000-000000000001',
      limit: 10,
      offset: 20,
    });

    expect(svc.calls).toEqual([
      {
        q: 'sour tangie',
        category: '01935f3d-0000-7000-8000-0000000000a1',
        strain_type: 'sativa',
        dispensary_id: '01935f3d-0000-7000-8000-000000000001',
        limit: 10,
        offset: 20,
      },
    ]);
  });

  it('returns the empty envelope unchanged when no rows match', async () => {
    const svc = new FakeSearchService();
    const controller = new SearchController(svc as unknown as SearchService);

    const res = await controller.searchProducts({ limit: 24, offset: 0 });

    expect(res).toEqual(EMPTY_RESPONSE);
  });
});
