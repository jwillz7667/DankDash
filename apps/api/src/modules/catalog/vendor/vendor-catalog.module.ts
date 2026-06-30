/**
 * Vendor catalog module — the /v1/vendor/products surface where a dispensary
 * authors and manages its OWN products (potency, identity, photos), distinct
 * from the admin-owned global catalog.
 *
 * Composition:
 *   - CatalogModule exports ProductsRepository + ProductCategoriesRepository
 *     (the same pooled repos the admin surface uses); the vendor service
 *     scopes every write by created_by_dispensary_id via the *ForDispensary
 *     repo methods.
 *   - ListingsModule provides VendorContextGuard (X-Dispensary-Id → staff
 *     membership) used by the controllers.
 *   - AuthModule provides RolesGuard; StorageModule provides R2Storage for the
 *     presigned product-image uploads.
 */
import {
  ProductCategoriesRepository,
  ProductsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { ListingsModule } from '../../listings/listings.module.js';
import { StorageModule } from '../../storage/storage.module.js';
import { VendorProductUploadsController } from './vendor-product-uploads.controller.js';
import { VendorProductUploadsService } from './vendor-product-uploads.service.js';
import { VendorProductsController } from './vendor-products.controller.js';
import { VendorProductsService } from './vendor-products.service.js';

// Self-contained repo providers so this module doesn't depend on CatalogModule's
// export surface (avoids a circular import risk and keeps the vendor catalog a
// leaf module). They close over the same pooled DRIZZLE_DB token.
const productsRepoProvider: FactoryProvider<ProductsRepository> = {
  provide: ProductsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductsRepository => new ProductsRepository(db),
};

const categoriesRepoProvider: FactoryProvider<ProductCategoriesRepository> = {
  provide: ProductCategoriesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductCategoriesRepository => new ProductCategoriesRepository(db),
};

const vendorProductsServiceProvider: FactoryProvider<VendorProductsService> = {
  provide: VendorProductsService,
  inject: [ProductsRepository, ProductCategoriesRepository],
  useFactory: (
    products: ProductsRepository,
    categories: ProductCategoriesRepository,
  ): VendorProductsService => new VendorProductsService(products, categories),
};

@Module({
  imports: [AuthModule, ListingsModule, StorageModule],
  controllers: [VendorProductsController, VendorProductUploadsController],
  providers: [
    productsRepoProvider,
    categoriesRepoProvider,
    vendorProductsServiceProvider,
    VendorProductUploadsService,
  ],
  exports: [VendorProductsService],
})
export class VendorCatalogModule {}
