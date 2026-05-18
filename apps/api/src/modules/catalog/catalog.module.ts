/**
 * Catalog feature module.
 *
 * Owns the global product catalog: products, categories, and lab results
 * (COAs). The catalog is the manufacturer/SKU-level view — what items
 * exist in the world. Per-dispensary pricing and inventory live in the
 * Listings module so a single product can be carried by many vendors
 * with independent price/inventory rows.
 *
 * Phase 4.2 wires the public read-side: GET /v1/categories,
 * GET /v1/products/:id. The product search endpoint lives in
 * SearchModule. Admin writes (Phase 4.3) and the catalog cache
 * (Phase 4.7) layer onto these providers without rewiring.
 */
import {
  ProductCategoriesRepository,
  ProductLabResultsRepository,
  ProductsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

const categoriesRepoProvider: FactoryProvider<ProductCategoriesRepository> = {
  provide: ProductCategoriesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductCategoriesRepository => new ProductCategoriesRepository(db),
};

const productsRepoProvider: FactoryProvider<ProductsRepository> = {
  provide: ProductsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductsRepository => new ProductsRepository(db),
};

const labResultsRepoProvider: FactoryProvider<ProductLabResultsRepository> = {
  provide: ProductLabResultsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductLabResultsRepository => new ProductLabResultsRepository(db),
};

const categoriesServiceProvider: FactoryProvider<CategoriesService> = {
  provide: CategoriesService,
  inject: [ProductCategoriesRepository],
  useFactory: (categories: ProductCategoriesRepository): CategoriesService =>
    new CategoriesService(categories),
};

const productsServiceProvider: FactoryProvider<ProductsService> = {
  provide: ProductsService,
  inject: [ProductsRepository, ProductLabResultsRepository],
  useFactory: (
    products: ProductsRepository,
    labResults: ProductLabResultsRepository,
  ): ProductsService => new ProductsService(products, labResults),
};

@Module({
  controllers: [CategoriesController, ProductsController],
  providers: [
    categoriesRepoProvider,
    productsRepoProvider,
    labResultsRepoProvider,
    categoriesServiceProvider,
    productsServiceProvider,
  ],
  exports: [
    CategoriesService,
    ProductsService,
    ProductCategoriesRepository,
    ProductsRepository,
    ProductLabResultsRepository,
  ],
})
export class CatalogModule {}
