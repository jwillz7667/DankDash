/**
 * Dispensary read orchestration.
 *
 *   list(query, now)    — active dispensaries, optionally filtered by a
 *                         (lat,lng) point against PostGIS `delivery_polygon`.
 *                         Computes per-dispensary `isOpenNow` / `opensAt`
 *                         in the dispensary's local zone (MN-default, but
 *                         the projection passes through any future zone
 *                         override unchanged).
 *   getById(id, now)    — single dispensary detail. Soft-deleted, non-active
 *                         (paused/terminated/onboarding) dispensaries surface
 *                         as 404 — never as a stub or tombstone.
 *   getMenu(id, now)    — joined listings + product projection. Calling
 *                         `getById` first means a 404 dispensary cannot leak
 *                         "we have no menu" via an empty array (which would
 *                         be indistinguishable from "we exist but carry
 *                         nothing today").
 *
 * `now` is threaded explicitly so tests can pin time deterministically — the
 * hours computation is timezone-aware and DST-aware, so a frozen instant is
 * the only honest way to assert "this dispensary is closed at noon on the
 * spring-forward day". The controller passes `new Date()` at the boundary.
 */
import { MN_DEFAULT_TIMEZONE, MN_SALES_HOURS } from '@dankdash/compliance';
import {
  DispensariesRepository,
  DispensaryListingsRepository,
  type Dispensary,
  type DispensaryListing,
  type Product,
} from '@dankdash/db';
import {
  isOpenAt,
  nextOpenAt,
  type DispensaryHours as HoursSchedule,
} from '@dankdash/dispensaries';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service.js';
import type {
  DispensaryResponse,
  ListDispensariesQuery,
  MenuItemResponse,
  MenuProductResponse,
  MenuResponse,
} from './dto/index.js';

@Injectable()
export class DispensariesService {
  constructor(
    private readonly dispensaries: DispensariesRepository,
    private readonly listings: DispensaryListingsRepository,
    private readonly cache: CatalogCacheService,
  ) {}

  async list(
    query: ListDispensariesQuery,
    now: Date = new Date(),
  ): Promise<readonly DispensaryResponse[]> {
    // Geo-filtered queries have unbounded key cardinality (lat/lng to 6
    // decimal places ≈ 11 cm precision) so caching them would just churn
    // the store. The PostGIS GIST index already keeps the geo path fast.
    // The unfiltered feed is the discovery-screen hot path — that's what
    // earns a cache slot.
    const fetch = async (): Promise<readonly DispensaryResponse[]> => {
      const rows = await this.fetchListRows(query);
      return rows.map((row) => projectDispensary(row, now));
    };
    if (query.lat !== undefined && query.lng !== undefined) {
      return fetch();
    }
    return this.cache.getDispensaryFeed(fetch);
  }

  async getById(id: string, now: Date = new Date()): Promise<DispensaryResponse> {
    const row = await this.dispensaries.findById(id);
    // optional-chain trick: `row?.x` is `undefined` when row is null, and
    // `undefined !== null` / `undefined !== 'active'` are both true — so a
    // single condition catches missing rows, tombstones, and non-active
    // statuses without a separate null guard.
    if (row?.deletedAt !== null || row.status !== 'active') {
      throw new NotFoundError('Dispensary', id);
    }
    return projectDispensary(row, now);
  }

  async getMenu(id: string, now: Date = new Date()): Promise<MenuResponse> {
    // 404 the dispensary first so a non-public store cannot be inferred from
    // a `{ items: [] }` response — keeps tombstones unprobeable. The 404
    // path runs the loader (no menu cache write) so a transient tombstone
    // does not poison the cache for 60s; only successful reads cache.
    await this.getById(id, now);
    return this.cache.getDispensaryMenu(id, async (): Promise<MenuResponse> => {
      const lines = await this.listings.listMenuForDispensary(id);
      return {
        dispensaryId: id,
        items: lines.map((line) => projectMenuItem(line.listing, line.product)),
      };
    });
  }

  private fetchListRows(query: ListDispensariesQuery): Promise<readonly Dispensary[]> {
    if (query.lat !== undefined && query.lng !== undefined) {
      return this.dispensaries.listDeliveringTo({
        type: 'Point',
        coordinates: [query.lng, query.lat],
      });
    }
    return this.dispensaries.listActive();
  }
}

function projectDispensary(row: Dispensary, now: Date): DispensaryResponse {
  const hours = row.hoursJson as HoursSchedule;
  const timezone = MN_DEFAULT_TIMEZONE;
  const openNow = isOpenAt(hours, now, timezone, MN_SALES_HOURS);
  const nextOpen = openNow ? null : nextOpenAt(hours, now, timezone, MN_SALES_HOURS);
  return {
    id: row.id,
    legalName: row.legalName,
    dba: row.dba,
    licenseNumber: row.licenseNumber,
    licenseType: row.licenseType,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    location: row.location,
    deliveryPolygon: row.deliveryPolygon,
    hours,
    phone: row.phone,
    email: row.email,
    logoImageKey: row.logoImageKey,
    heroImageKey: row.heroImageKey,
    brandColorHex: row.brandColorHex,
    isAcceptingOrders: row.isAcceptingOrders,
    isOpenNow: openNow,
    opensAt: nextOpen === null ? null : nextOpen.toISOString(),
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectMenuItem(listing: DispensaryListing, product: Product): MenuItemResponse {
  return {
    listingId: listing.id,
    sku: listing.sku,
    priceCents: listing.priceCents,
    compareAtPriceCents: listing.compareAtPriceCents,
    quantityAvailable: listing.quantityAvailable,
    product: projectMenuProduct(product),
  };
}

function projectMenuProduct(product: Product): MenuProductResponse {
  return {
    id: product.id,
    categoryId: product.categoryId,
    brand: product.brand,
    name: product.name,
    description: product.description,
    productType: product.productType,
    strainType: product.strainType,
    thcMgPerUnit: product.thcMgPerUnit,
    cbdMgPerUnit: product.cbdMgPerUnit,
    weightGramsPerUnit: product.weightGramsPerUnit,
    servingCount: product.servingCount,
    thcMgPerServing: product.thcMgPerServing,
    imageKeys: product.imageKeys,
    effectsTags: product.effectsTags,
    flavorTags: product.flavorTags,
  };
}
