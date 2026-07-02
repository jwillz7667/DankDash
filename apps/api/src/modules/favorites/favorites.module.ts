/**
 * Favorites feature module — mounts the consumer `/v1/me/favorites` surface.
 *
 * FavoritesService is a pure singleton over three singleton repositories, so it
 * follows IdentityService's direct-inject pattern rather than the scoped-repos
 * closure (there is no cross-table transaction to bind). Each repository is
 * built once from the shared Drizzle `Database`. AuthModule is imported so the
 * global JwtAuthGuard + RolesGuard/decorators resolve exactly as they do for
 * every other feature module.
 */
import {
  DispensariesRepository,
  FavoritesRepository,
  ProductsRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FavoritesController } from './favorites.controller.js';
import { FavoritesService } from './favorites.service.js';

const favoritesRepositoryProvider: FactoryProvider<FavoritesRepository> = {
  provide: FavoritesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): FavoritesRepository => new FavoritesRepository(db),
};

const dispensariesRepositoryProvider: FactoryProvider<DispensariesRepository> = {
  provide: DispensariesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensariesRepository => new DispensariesRepository(db),
};

const productsRepositoryProvider: FactoryProvider<ProductsRepository> = {
  provide: ProductsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): ProductsRepository => new ProductsRepository(db),
};

const favoritesServiceProvider: FactoryProvider<FavoritesService> = {
  provide: FavoritesService,
  inject: [FavoritesRepository, DispensariesRepository, ProductsRepository],
  useFactory: (
    favorites: FavoritesRepository,
    dispensaries: DispensariesRepository,
    products: ProductsRepository,
  ): FavoritesService => new FavoritesService(favorites, dispensaries, products),
};

@Module({
  imports: [AuthModule],
  controllers: [FavoritesController],
  providers: [
    favoritesRepositoryProvider,
    dispensariesRepositoryProvider,
    productsRepositoryProvider,
    favoritesServiceProvider,
  ],
  exports: [FavoritesService],
})
export class FavoritesModule {}
