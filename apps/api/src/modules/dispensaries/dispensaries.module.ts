/**
 * Dispensaries feature module.
 *
 * Owns the public dispensary read surface (geo-filtered list, detail, menu)
 * and the admin write surface (create, patch, activate, suspend). Listings
 * are split into their own module since they have a different access model
 * (vendor RLS-scoped writes vs. admin-only writes here).
 *
 * The menu endpoint joins listings with products. Rather than depend on
 * CatalogModule and reach across feature boundaries for that join, this
 * module declares its own DispensaryListingsRepository provider — the
 * repository is a thin SQL projection with no hidden state, so two
 * instances against the same Database are equivalent and the symmetry
 * keeps each module independently bootable in tests.
 *
 * AuthModule is imported so RolesGuard is available for the admin
 * controller's @UseGuards(RolesGuard); JwtAuthGuard is already bound
 * globally in the root composition and authenticates every non-@Public
 * request before RolesGuard runs.
 */
import {
  DispensariesRepository,
  DispensaryListingsRepository,
  DispensaryStaffRepository,
  type Database,
} from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AdminDispensariesController } from './admin/admin-dispensaries.controller.js';
import { AdminDispensariesService } from './admin/admin-dispensaries.service.js';
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

const staffRepoProvider: FactoryProvider<DispensaryStaffRepository> = {
  provide: DispensaryStaffRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensaryStaffRepository => new DispensaryStaffRepository(db),
};

const dispensariesServiceProvider: FactoryProvider<DispensariesService> = {
  provide: DispensariesService,
  inject: [DispensariesRepository, DispensaryListingsRepository],
  useFactory: (
    dispensaries: DispensariesRepository,
    listings: DispensaryListingsRepository,
  ): DispensariesService => new DispensariesService(dispensaries, listings),
};

const adminDispensariesServiceProvider: FactoryProvider<AdminDispensariesService> = {
  provide: AdminDispensariesService,
  inject: [DispensariesRepository, DispensaryStaffRepository],
  useFactory: (
    dispensaries: DispensariesRepository,
    staff: DispensaryStaffRepository,
  ): AdminDispensariesService => new AdminDispensariesService(dispensaries, staff),
};

@Module({
  imports: [AuthModule],
  controllers: [DispensariesController, AdminDispensariesController],
  providers: [
    dispensariesRepoProvider,
    listingsRepoProvider,
    staffRepoProvider,
    dispensariesServiceProvider,
    adminDispensariesServiceProvider,
  ],
  exports: [
    DispensariesService,
    AdminDispensariesService,
    DispensariesRepository,
    DispensaryListingsRepository,
    DispensaryStaffRepository,
  ],
})
export class DispensariesModule {}
