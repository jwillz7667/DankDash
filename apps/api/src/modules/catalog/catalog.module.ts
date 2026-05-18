/**
 * Catalog feature module.
 *
 * Owns the global product catalog: products, categories, and lab results
 * (COAs). The catalog is the manufacturer/SKU-level view — what items
 * exist in the world. Per-dispensary pricing and inventory live in the
 * Listings module so a single product can be carried by many vendors
 * with independent price/inventory rows.
 *
 * Controllers, services, and DI wiring land in Phase 4.2 (customer
 * product reads) and Phase 4.3 (admin product / category / lab-result
 * writes).
 */
import { Module } from '@nestjs/common';

@Module({})
export class CatalogModule {}
