/**
 * Product search orchestration.
 *
 *   search(query) — runs the faceted catalog search against
 *                   `ProductsRepository.searchWithFilters`, projects the
 *                   rows into the narrower SearchProductResult shape
 *                   (no description, no lab results, no timestamps) and
 *                   wraps the response with facet counts + the page
 *                   metadata the iOS pager renders.
 *
 * The projection is deliberately a function of `Product` alone — every
 * field comes from the row itself, no joins. That lets the repository
 * pick whatever index plan is cheapest (typically `products_category_idx`
 * partial-index for category-filtered browses; `search_vector` GIN for
 * free-text). Adding category or brand metadata to the projection later
 * would force a join here; defer it until the iOS UI actually needs it.
 *
 * The endpoint contract guarantees a stable shape even on empty results:
 * `results: []`, `facets.categories: []`, `facets.strainTypes: []`,
 * `page.total: 0`. The iOS client renders the "no results" empty state
 * by checking `results.length === 0` rather than a separate flag.
 */
import { ProductsRepository, type Product } from '@dankdash/db';
import { Injectable } from '@nestjs/common';
import type {
  SearchProductResult,
  SearchProductsQuery,
  SearchProductsResponse,
} from './dto/index.js';

@Injectable()
export class SearchService {
  constructor(private readonly products: ProductsRepository) {}

  async search(query: SearchProductsQuery): Promise<SearchProductsResponse> {
    const limit = query.limit;
    const offset = query.offset;
    const page = await this.products.searchWithFilters({
      query: query.q,
      categoryId: query.category,
      strainType: query.strain_type,
      dispensaryId: query.dispensary_id,
      limit,
      offset,
    });

    return {
      results: page.results.map((row) => projectSearchResult(row)),
      facets: {
        categories: page.categoryFacets,
        strainTypes: page.strainTypeFacets,
      },
      page: {
        limit,
        offset,
        total: page.total,
      },
    };
  }
}

function projectSearchResult(product: Product): SearchProductResult {
  return {
    id: product.id,
    categoryId: product.categoryId,
    brand: product.brand,
    name: product.name,
    productType: product.productType,
    strainType: product.strainType,
    thcMgPerUnit: product.thcMgPerUnit,
    cbdMgPerUnit: product.cbdMgPerUnit,
    weightGramsPerUnit: product.weightGramsPerUnit,
    servingCount: product.servingCount,
    thcMgPerServing: product.thcMgPerServing,
    imageKeys: product.imageKeys,
    effectsTags: product.effectsTags,
    flavorTags: product.flavorTags,
  };
}
