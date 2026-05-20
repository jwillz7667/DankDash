/**
 * Staff feature module (Phase 15.4).
 *
 * Owns the vendor-portal staff surface — `/v1/vendor/staff` and the
 * companion write paths. Read + mutate endpoints scoped by
 * VendorContextGuard (provided transitively via ListingsModule, same as
 * PayoutsModule).
 *
 * The service receives a scoped repo factory so unit tests can swap in
 * in-memory fakes for both `DispensaryStaffRepository` and `UsersRepository`
 * — invites and re-invites cross both tables.
 *
 * Audit-log writes are NOT done here yet; the `audit_log` table exists but
 * is not connected through the API modules. Once that wiring lands, every
 * mutation in `VendorStaffService` becomes a call site for it.
 */
import { DispensaryStaffRepository, UsersRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { VendorStaffController } from './vendor/vendor-staff.controller.js';
import { VendorStaffService, type StaffRepos } from './vendor/vendor-staff.service.js';

const vendorStaffServiceProvider: FactoryProvider<VendorStaffService> = {
  provide: VendorStaffService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): VendorStaffService =>
    new VendorStaffService(
      (): StaffRepos => ({
        staff: new DispensaryStaffRepository(db),
        users: new UsersRepository(db),
      }),
    ),
};

@Module({
  imports: [AuthModule, ListingsModule],
  controllers: [VendorStaffController],
  providers: [vendorStaffServiceProvider],
  exports: [VendorStaffService],
})
export class StaffModule {}
