/**
 * Vendor settings service (Phase 15.5).
 *
 *   get(ctx)            — full settings projection for the active dispensary
 *   patch(ctx, body)    — partial update of editable settings fields
 *
 * Editable fields (operator-controlled):
 *
 *   - hours (full schedule, day-by-day)
 *   - phone, email
 *   - logoImageKey, heroImageKey
 *   - brandColorHex
 *   - isAcceptingOrders
 *
 * Read-only fields (platform-owned, surface in the response but rejected
 * by PATCH if attempted):
 *
 *   - legalName, dba, licenseNumber, licenseType, licenseIssuedAt,
 *     licenseExpiresAt, status, addressLine*, city, region, postalCode,
 *     location, deliveryPolygon
 *   - aeropayAccountRef, posProvider, posCredentialsEnc, posLastSyncedAt,
 *     metrcFacilityId, metrcApiKeyEnc
 *
 * The patch DTO statically excludes the read-only fields, so any extra
 * key on the wire gets `.strict()`-rejected at the validator boundary
 * before we reach the service.
 */
import { DispensariesRepository, type Dispensary } from '@dankdash/db';
import { type DispensaryHours as HoursSchedule } from '@dankdash/dispensaries';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type { PatchVendorSettingsRequest, VendorSettingsResponse } from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';

/** Pre-bound repo accessor — production closes over the pooled DB token,
 *  tests return an in-memory fake. */
export type SettingsRepoFactory = () => DispensariesRepository;

@Injectable()
export class VendorSettingsService {
  constructor(private readonly repoFor: SettingsRepoFactory) {}

  async get(ctx: VendorContext): Promise<VendorSettingsResponse> {
    const repo = this.repoFor();
    const row = await repo.findById(ctx.dispensaryId);
    if (row?.deletedAt !== null) {
      throw new NotFoundError('Dispensary', ctx.dispensaryId);
    }
    return project(row);
  }

  async patch(
    ctx: VendorContext,
    body: PatchVendorSettingsRequest,
  ): Promise<VendorSettingsResponse> {
    const repo = this.repoFor();
    const row = await repo.findById(ctx.dispensaryId);
    if (row?.deletedAt !== null) {
      throw new NotFoundError('Dispensary', ctx.dispensaryId);
    }

    // Map the patch payload onto the column-name shape `repo.update`
    // expects. `hours` lives in the `hoursJson` column.
    const patch: Parameters<DispensariesRepository['update']>[1] = {};
    if (body.hours !== undefined) patch.hoursJson = body.hours;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.email !== undefined) patch.email = body.email;
    if (body.logoImageKey !== undefined) patch.logoImageKey = body.logoImageKey;
    if (body.heroImageKey !== undefined) patch.heroImageKey = body.heroImageKey;
    if (body.brandColorHex !== undefined) patch.brandColorHex = body.brandColorHex;
    if (body.isAcceptingOrders !== undefined) {
      patch.isAcceptingOrders = body.isAcceptingOrders;
    }

    const updated = await repo.update(ctx.dispensaryId, patch);
    if (updated === null) throw new NotFoundError('Dispensary', ctx.dispensaryId);
    return project(updated);
  }
}

function project(row: Dispensary): VendorSettingsResponse {
  return {
    id: row.id,
    legalName: row.legalName,
    dba: row.dba,
    licenseNumber: row.licenseNumber,
    licenseType: row.licenseType,
    licenseIssuedAt: row.licenseIssuedAt,
    licenseExpiresAt: row.licenseExpiresAt,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    location: row.location,
    deliveryPolygon: row.deliveryPolygon,
    hours: row.hoursJson as HoursSchedule,
    phone: row.phone,
    email: row.email,
    logoImageKey: row.logoImageKey,
    heroImageKey: row.heroImageKey,
    brandColorHex: row.brandColorHex,
    isAcceptingOrders: row.isAcceptingOrders,
    status: row.status,
    posProvider: row.posProvider,
    posLastSyncedAt: row.posLastSyncedAt === null ? null : row.posLastSyncedAt.toISOString(),
    hasPosCredentials: row.posCredentialsEnc !== null,
    metrcFacilityId: row.metrcFacilityId,
    hasMetrcCredentials: row.metrcApiKeyEnc !== null,
    hasAeropayAccount: row.aeropayAccountRef !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
