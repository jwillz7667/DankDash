/**
 * Search feature module.
 *
 * Owns product search (tsvector + GIN-indexed full-text search with
 * relevance ranking and faceted counts) and the dispensary discovery
 * feed (PostGIS `ST_Contains` against `delivery_polygon` with
 * open-now / opens-at metadata computed via `@dankdash/dispensaries`).
 *
 * Controllers, services, and DI wiring land in Phase 4.2.
 */
import { Module } from '@nestjs/common';

@Module({})
export class SearchModule {}
