/**
 * Catalog feature module.
 *
 * Owns the global product catalog: products, categories, and lab results
 * (COAs). The catalog is the manufacturer/SKU-level view — what items
 * exist in the world. Per-dispensary pricing and inventory live in the
 * Listings module so a single product can be carried by many vendors
 * with independent price/inventory rows.
 *
 * Phase 4.2 wires the public read-side: GET /v1/categories. Product
 * reads (GET /v1/products/:id) and admin writes land in the next commits
 * of this phase.
 */
import { ProductCategoriesRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';

const categoriesRepoProvider: FactoryProvider<ProductCategoriesRepository> = {
  provide: ProductCategoriesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductCategoriesRepository => new ProductCategoriesRepository(db),
};

const categoriesServiceProvider: FactoryProvider<CategoriesService> = {
  provide: CategoriesService,
  inject: [ProductCategoriesRepository],
  useFactory: (categories: ProductCategoriesRepository): CategoriesService =>
    new CategoriesService(categories),
};

@Module({
  controllers: [CategoriesController],
  providers: [categoriesRepoProvider, categoriesServiceProvider],
  exports: [CategoriesService, ProductCategoriesRepository],
})
export class CatalogModule {}
