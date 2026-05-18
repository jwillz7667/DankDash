/**
 * GET /v1/products/search — ranking + facets + filters integration.
 *
 * The seed pins three products whose names contain "Northern Lights" or
 * "Durban Poison" so the websearch_to_tsquery + ts_rank path can be
 * exercised end-to-end. The repository's ranking clause is
 *   `ORDER BY ts_rank(search_vector, websearch_to_tsquery('english', q)) DESC, products.id`
 * — the secondary key by id keeps the test deterministic when two rows
 * tie on rank.
 *
 * Facets are computed across the *same* filter set as the rows (see
 * SearchProductsQuerySchema for the rationale on the v1 facet design);
 * this test checks the shape but not the cross-dimension counts.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, seedFixtures } from './setup.js';

describe('GET /v1/products/search', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await seedFixtures();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('returns ranked hits for a free-text query that matches multiple products', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/products/search?q=northern+lights',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      results: ReadonlyArray<{ id: string; name: string }>;
      facets: {
        categories: ReadonlyArray<{ categoryId: string; count: number }>;
        strainTypes: ReadonlyArray<{ strainType: string; count: number }>;
      };
      page: { limit: number; offset: number; total: number };
    }>();
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(SEED_IDS.product.northernLights7g);
    expect(ids).toContain(SEED_IDS.product.northernLightsPreroll);
    // ts_rank ordering: every returned row is a Northern Lights hit. Names
    // that do not contain the term should not appear.
    for (const row of body.results) {
      expect(row.name.toLowerCase()).toContain('northern lights');
    }
    expect(body.page.limit).toBe(24);
    expect(body.page.offset).toBe(0);
    expect(body.page.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.facets.categories)).toBe(true);
    expect(Array.isArray(body.facets.strainTypes)).toBe(true);
  });

  it('returns a different, but overlapping, ranking for a distinct query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/products/search?q=durban',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: ReadonlyArray<{ id: string; name: string }> }>();
    const ids = body.results.map((r) => r.id);
    expect(ids).toContain(SEED_IDS.product.durbanPoison35g);
    expect(ids).toContain(SEED_IDS.product.durbanPoison5Pack);
    expect(ids).not.toContain(SEED_IDS.product.northernLights7g);
  });

  it('narrows to a single category when ?category= is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/products/search?category=${SEED_IDS.category.flower}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      results: ReadonlyArray<{ categoryId: string }>;
      facets: { categories: ReadonlyArray<{ categoryId: string; count: number }> };
    }>();
    expect(body.results.length).toBeGreaterThan(0);
    for (const row of body.results) {
      expect(row.categoryId).toBe(SEED_IDS.category.flower);
    }
    // Facet must reflect the narrowed result set, not the global catalog.
    expect(body.facets.categories).toEqual([
      { categoryId: SEED_IDS.category.flower, count: body.results.length },
    ]);
  });

  it('narrows to a single dispensary when ?dispensary_id= is supplied', async () => {
    // MG (Maple Grove) seed skips concentrate / vape / infused_preroll
    // listings (see seed.ts §listings) — narrowing the search to MG must
    // therefore never surface those product types, and the total must be
    // strictly smaller than the global catalog total for the same query.
    const mgRes = await app.inject({
      method: 'GET',
      url: `/v1/products/search?dispensary_id=${SEED_IDS.dispensary.mg}`,
    });
    const globalRes = await app.inject({
      method: 'GET',
      url: '/v1/products/search',
    });
    expect(mgRes.statusCode).toBe(200);
    expect(globalRes.statusCode).toBe(200);
    const mg = mgRes.json<{
      results: ReadonlyArray<{ productType: string }>;
      page: { total: number };
    }>();
    const global = globalRes.json<{ page: { total: number } }>();
    expect(mg.results.length).toBeGreaterThan(0);
    const skipped = new Set(['concentrate', 'vape', 'infused_preroll']);
    for (const row of mg.results) {
      expect(skipped.has(row.productType)).toBe(false);
    }
    expect(mg.page.total).toBeLessThan(global.page.total);
  });

  it('returns empty results for an unknown ?dispensary_id= without leaking existence', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/products/search?dispensary_id=00000000-0000-7000-8000-000000000000',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: ReadonlyArray<unknown>; page: { total: number } }>();
    expect(body.results).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  it('honours limit + offset paging', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/v1/products/search?limit=5&offset=0',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/v1/products/search?limit=5&offset=5',
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json<{
      results: ReadonlyArray<{ id: string }>;
      page: { limit: number; offset: number; total: number };
    }>();
    const b = second.json<{
      results: ReadonlyArray<{ id: string }>;
      page: { limit: number; offset: number; total: number };
    }>();
    expect(a.results.length).toBe(5);
    expect(b.results.length).toBeGreaterThan(0);
    expect(a.page.total).toBe(b.page.total);
    // Pages do not overlap.
    const overlap = a.results.map((r) => r.id).filter((id) => b.results.some((y) => y.id === id));
    expect(overlap).toEqual([]);
  });

  it('rejects out-of-range limit with 422', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/products/search?limit=999' });
    expect(res.statusCode).toBe(422);
  });
});
