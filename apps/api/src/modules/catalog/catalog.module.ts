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
 * GET /v1/products/:id. Phase 4.3 layers the admin write surface
 * (create + patch products, create categories, append COAs) onto the
 * same providers without rewiring. The catalog cache (Phase 4.7)
 * lands as another decorator over the read services.
 *
 * AuthModule is imported so RolesGuard is available for the admin
 * controllers' @UseGuards(RolesGuard); JwtAuthGuard is already bound
 * globally in the root composition and authenticates every non-@Public
 * request before RolesGuard runs.
 */
import {
  ProductCategoriesRepository,
  ProductLabResultsRepository,
  ProductsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminCategoriesController } from './admin/admin-categories.controller.js';
import { AdminCategoriesService } from './admin/admin-categories.service.js';
import { AdminProductsController } from './admin/admin-products.controller.js';
import { AdminProductsService } from './admin/admin-products.service.js';
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

const adminCategoriesServiceProvider: FactoryProvider<AdminCategoriesService> = {
  provide: AdminCategoriesService,
  inject: [ProductCategoriesRepository],
  useFactory: (categories: ProductCategoriesRepository): AdminCategoriesService =>
    new AdminCategoriesService(categories),
};

const adminProductsServiceProvider: FactoryProvider<AdminProductsService> = {
  provide: AdminProductsService,
  inject: [ProductsRepository, ProductCategoriesRepository, ProductLabResultsRepository],
  useFactory: (
    products: ProductsRepository,
    categories: ProductCategoriesRepository,
    labResults: ProductLabResultsRepository,
  ): AdminProductsService => new AdminProductsService(products, categories, labResults),
};

@Module({
  imports: [AuthModule],
  controllers: [
    CategoriesController,
    ProductsController,
    AdminCategoriesController,
    AdminProductsController,
  ],
  providers: [
    categoriesRepoProvider,
    productsRepoProvider,
    labResultsRepoProvider,
    categoriesServiceProvider,
    productsServiceProvider,
    adminCategoriesServiceProvider,
    adminProductsServiceProvider,
  ],
  exports: [
    CategoriesService,
    ProductsService,
    AdminCategoriesService,
    AdminProductsService,
    ProductCategoriesRepository,
    ProductsRepository,
    ProductLabResultsRepository,
  ],
})
export class CatalogModule {}
