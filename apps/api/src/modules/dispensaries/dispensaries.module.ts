/**
 * Dispensaries feature module.
 *
 * Owns the public dispensary read surface (geo-filtered list, detail, menu)
 * and — once Phase 4.3 lands — the admin write surface (create, patch,
 * activate, suspend). Listings are split into their own module since they
 * have a different access model (vendor RLS-scoped writes vs. admin-only
 * writes here).
 *
 * The menu endpoint joins listings with products. Rather than depend on
 * CatalogModule and reach across feature boundaries for that join, this
 * module declares its own DispensaryListingsRepository provider — the
 * repository is a thin SQL projection with no hidden state, so two
 * instances against the same Database are equivalent and the symmetry
 * keeps each module independently bootable in tests.
 */
import { DispensariesRepository, DispensaryListingsRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { DispensariesController } from './dispensaries.controller.js';
import { DispensariesService } from './dispensaries.service.js';

const dispensariesRepoProvider: FactoryProvider<DispensariesRepository> = {
  provide: DispensariesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensariesRepository => new DispensariesRepository(db),
};

const listingsRepoProvider: FactoryProvider<DispensaryListingsRepository> = {
  provide: DispensaryListingsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensaryListingsRepository => new DispensaryListingsRepository(db),
};

const dispensariesServiceProvider: FactoryProvider<DispensariesService> = {
  provide: DispensariesService,
  inject: [DispensariesRepository, DispensaryListingsRepository],
  useFactory: (
    dispensaries: DispensariesRepository,
    listings: DispensaryListingsRepository,
  ): DispensariesService => new DispensariesService(dispensaries, listings),
};

@Module({
  controllers: [DispensariesController],
  providers: [dispensariesRepoProvider, listingsRepoProvider, dispensariesServiceProvider],
  exports: [DispensariesService, DispensariesRepository, DispensaryListingsRepository],
})
export class DispensariesModule {}
