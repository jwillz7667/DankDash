/**
 * Search feature module.
 *
 * Owns product search (tsvector + GIN-indexed full-text search with
 * relevance ranking and faceted counts). The dispensary discovery feed
 * lives in DispensariesModule — it shares no code with product search
 * and routing it through a sibling module would couple two unrelated
 * concerns under one DI surface.
 *
 * ProductsRepository is declared as a provider here in addition to
 * CatalogModule. The repository is a thin SQL projection with no hidden
 * state, so two instances against the same Database are observationally
 * identical and the symmetry keeps each module independently bootable in
 * tests (see DispensariesModule for the same pattern with
 * DispensaryListingsRepository).
 */
import { ProductsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

const productsRepoProvider: FactoryProvider<ProductsRepository> = {
  provide: ProductsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductsRepository => new ProductsRepository(db),
};

const searchServiceProvider: FactoryProvider<SearchService> = {
  provide: SearchService,
  inject: [ProductsRepository],
  useFactory: (products: ProductsRepository): SearchService => new SearchService(products),
};

@Module({
  controllers: [SearchController],
  providers: [productsRepoProvider, searchServiceProvider],
  exports: [SearchService],
})
export class SearchModule {}
