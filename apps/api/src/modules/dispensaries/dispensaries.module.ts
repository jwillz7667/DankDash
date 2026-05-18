/**
 * Dispensaries feature module.
 *
 * Owns the public dispensary surface (geo-filtered list, single read, hours)
 * and the admin write surface (create, patch, activate, suspend). Listings
 * are split into their own module since they have a different access model
 * (vendor RLS-scoped vs. admin-only writes here).
 *
 * Controllers, services, and DI wiring land in Phase 4.2 (customer reads)
 * and Phase 4.3 (admin writes).
 */
import { Module } from '@nestjs/common';

@Module({})
export class DispensariesModule {}
