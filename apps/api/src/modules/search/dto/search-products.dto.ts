/**
 * Query + response DTOs for `GET /v1/products/search`.
 *
 * Search is a public browse surface, so the query is strictly typed and
 * permissive about absent parameters:
 *
 *   q              — free-text. Accepted in `websearch_to_tsquery` grammar
 *                    (quoted phrases, OR, -negation). Optional — an empty
 *                    query browses the catalog ordered by brand/name.
 *   category       — exact category UUID. The mobile client passes the id it
 *                    received from `GET /v1/categories`; matching on slug
 *                    would require an extra round-trip to translate.
 *   strain_type    — one of the canonical strain enums. Distinct from the
 *                    indica/sativa/hybrid filter UI labels because we also
 *                    expose 'cbd' and 'balanced' for tincture/edible browse.
 *   dispensary_id  — narrows results to products the named store actively
 *                    carries (active + in-stock listings). The dispensary
 *                    must be active and non-deleted; the service layer
 *                    enforces that and 404s otherwise — keeping a soft-
 *                    deleted store from being a passive product index.
 *   limit          — page size, 1..50. Default 24 so the iOS grid renders
 *                    a clean 3x8.
 *   offset         — page offset, ≥0. We use offset rather than a cursor
 *                    here because the search ranking is stable per-query and
 *                    pages > 5 are vanishingly rare in browse traffic; a
 *                    cursor design lands when category cardinality crosses
 *                    the 10k mark (tracked in the Phase 4 follow-ups).
 *
 * Reasons the response shape includes facets:
 *
 *   The mobile and web browse UIs render "12 in Flower, 4 in Vape" pills
 *   alongside the result list so the user can refine without typing. Pre-
 *   computing the facet counts server-side means the UI never has to
 *   second-guess what would happen if it changed the filter.
 *
 *   Facets are computed across the *filtered* result set EXCLUDING the
 *   facet's own dimension would be the textbook approach, but in v1 we
 *   intentionally compute facets across the same filter set as the rows
 *   — this matches the simpler discovery UX where category pills act as
 *   tabs, not refinements. The richer "drill-down" facet is a Phase 5
 *   feature.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { NUMERIC_STRING, ProductTypeSchema, StrainTypeSchema } from '../../catalog/dto/index.js';

export const SearchProductsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    category: z.string().uuid().optional(),
    strain_type: StrainTypeSchema.optional(),
    dispensary_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(24),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type SearchProductsQuery = z.infer<typeof SearchProductsQuerySchema>;

export class SearchProductsQueryDto extends createZodDto(SearchProductsQuerySchema) {}

/**
 * Hit shape. Deliberately narrower than `ProductResponse`:
 *
 *   - No `description` — search results are list items; description belongs
 *     on the detail screen via `GET /v1/products/:id`.
 *   - No `labResults` — same rationale; cuts payload roughly in half on
 *     dense category browses.
 *   - No `createdAt`/`updatedAt` — internal-ish timestamps that the
 *     browse UI never renders.
 *
 * Numeric fields keep the string-decimal contract from the catalog DTO
 * (NUMERIC_STRING) so the client never has to second-guess precision.
 */
export const SearchProductResultSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    brand: z.string(),
    name: z.string(),
    productType: ProductTypeSchema,
    strainType: StrainTypeSchema.nullable(),
    thcMgPerUnit: NUMERIC_STRING,
    cbdMgPerUnit: NUMERIC_STRING,
    weightGramsPerUnit: NUMERIC_STRING,
    servingCount: z.number().int().nullable(),
    thcMgPerServing: NUMERIC_STRING.nullable(),
    imageKeys: z.array(z.string()).readonly(),
    effectsTags: z.array(z.string()).readonly(),
    flavorTags: z.array(z.string()).readonly(),
  })
  .strict();

export type SearchProductResult = z.infer<typeof SearchProductResultSchema>;

export const SearchFacetCategorySchema = z
  .object({
    categoryId: z.string().uuid(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const SearchFacetStrainTypeSchema = z
  .object({
    strainType: StrainTypeSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

export const SearchPageSchema = z
  .object({
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().min(0),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const SearchProductsResponseSchema = z
  .object({
    results: z.array(SearchProductResultSchema).readonly(),
    facets: z
      .object({
        categories: z.array(SearchFacetCategorySchema).readonly(),
        strainTypes: z.array(SearchFacetStrainTypeSchema).readonly(),
      })
      .strict(),
    page: SearchPageSchema,
  })
  .strict();

export type SearchProductsResponse = z.infer<typeof SearchProductsResponseSchema>;
