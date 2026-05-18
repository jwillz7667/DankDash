/**
 * Listings feature module.
 *
 * Owns dispensary-scoped pricing and inventory rows that bind a global
 * product to a specific dispensary at a specific price with a specific
 * quantity-on-hand. The vendor surface (list/create/patch/delete the
 * dispensary's own listings) is RLS-scoped via `SET LOCAL
 * app.current_dispensary_id` so cross-dispensary access returns 404
 * rather than 403 (avoiding info leak about other vendors).
 *
 * Controllers, services, and DI wiring land in Phase 4.4.
 */
import { Module } from '@nestjs/common';

@Module({})
export class ListingsModule {}
