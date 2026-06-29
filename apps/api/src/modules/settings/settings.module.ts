/**
 * Settings feature module (Phase 15.5).
 *
 * Owns the vendor-portal settings surface — `/v1/vendor/settings`.
 * The service receives a scoped repo factory (DispensariesRepository) so
 * unit tests can swap an in-memory fake, mirroring the StaffModule shape.
 *
 * Read + mutate endpoints scoped by VendorContextGuard (provided
 * transitively via ListingsModule). AuthModule is imported for the
 * RolesGuard + Roles decorator.
 */
import { DispensariesRepository, type Database } from '@dankdash/db';
import { Module, type FactoryProvider } from '@nestjs/common';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VendorSettingsUploadsController } from './vendor/vendor-settings-uploads.controller.js';
import { VendorSettingsUploadsService } from './vendor/vendor-settings-uploads.service.js';
import { VendorSettingsController } from './vendor/vendor-settings.controller.js';
import { VendorSettingsService } from './vendor/vendor-settings.service.js';

const vendorSettingsServiceProvider: FactoryProvider<VendorSettingsService> = {
  provide: VendorSettingsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): VendorSettingsService =>
    new VendorSettingsService((): DispensariesRepository => new DispensariesRepository(db)),
};

@Module({
  imports: [AuthModule, ListingsModule, StorageModule],
  controllers: [VendorSettingsController, VendorSettingsUploadsController],
  providers: [vendorSettingsServiceProvider, VendorSettingsUploadsService],
  exports: [VendorSettingsService],
})
export class SettingsModule {}
