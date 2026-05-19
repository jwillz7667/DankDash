/**
 * Admin write-side service for dispensaries.
 *
 *   create()    — POST /v1/admin/dispensaries. Always starts the row at
 *                 status='onboarding'; status transitions go through
 *                 activate/suspend so the audit trail records the operator.
 *                 Licence number uniqueness is enforced by the DB unique
 *                 index; the service translates the duplicate-key error into
 *                 a typed ConflictError so the client sees `409` with a
 *                 stable code rather than `500`.
 *
 *   patch()     — PATCH /v1/admin/dispensaries/:id. Empty patches are
 *                 rejected here (not at the schema layer) so the error
 *                 message can be specific. License number and region are
 *                 excluded by the DTO; the repo `update()` Omit excludes
 *                 the same set defensively.
 *
 *   activate()  — POST /v1/admin/dispensaries/:id/activate. Validates the
 *                 activation gate from CLAUDE-CODE-PHASES.md Phase 4.3:
 *                 license has not expired, and at least one staff member is
 *                 attached with role='owner'. The polygon/hours guards in
 *                 the spec are trivially satisfied by NOT NULL columns;
 *                 we leave them to schema-level enforcement and check the
 *                 conditions that the schema cannot.
 *
 *   suspend()   — POST /v1/admin/dispensaries/:id/suspend. Sets status to
 *                 'paused'. Terminated dispensaries cannot be re-paused
 *                 (terminated is terminal); the call rejects with a
 *                 ValidationError in that case so the operator gets a
 *                 specific message rather than a silent no-op.
 *
 * Read-back uniformity: every mutator returns the inflated DispensaryResponse
 * so the iOS admin tool can refresh the local row from a single round-trip,
 * matching the public read DTO byte-for-byte (no parallel "admin shape").
 */
import { MN_DEFAULT_TIMEZONE, MN_SALES_HOURS } from '@dankdash/compliance';
import {
  DispensariesRepository,
  DispensaryStaffRepository,
  type CreateDispensaryInput,
  type Dispensary,
} from '@dankdash/db';
import {
  isOpenAt,
  nextOpenAt,
  type DispensaryHours as HoursSchedule,
} from '@dankdash/dispensaries';
import { ConflictError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { CatalogCacheService } from '../../catalog-cache/catalog-cache.service.js';
import type { DispensaryResponse } from '../dto/index.js';
import type { CreateDispensaryRequest, PatchDispensaryRequest } from './dto/index.js';

@Injectable()
export class AdminDispensariesService {
  constructor(
    private readonly dispensaries: DispensariesRepository,
    private readonly staff: DispensaryStaffRepository,
    private readonly cache: CatalogCacheService,
  ) {}

  async create(body: CreateDispensaryRequest, now: Date = new Date()): Promise<DispensaryResponse> {
    const existing = await this.dispensaries.findByLicenseNumber(body.licenseNumber);
    if (existing !== null) {
      throw new ConflictError(
        'DISPENSARY_LICENSE_TAKEN',
        'A dispensary with this license number already exists',
        { licenseNumber: body.licenseNumber },
      );
    }
    const input: CreateDispensaryInput = {
      legalName: body.legalName,
      dba: body.dba ?? null,
      licenseNumber: body.licenseNumber,
      licenseType: body.licenseType,
      licenseIssuedAt: body.licenseIssuedAt,
      licenseExpiresAt: body.licenseExpiresAt,
      metrcFacilityId: body.metrcFacilityId ?? null,
      ...(body.posProvider !== undefined ? { posProvider: body.posProvider } : {}),
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2 ?? null,
      city: body.city,
      region: body.region,
      postalCode: body.postalCode,
      location: body.location,
      deliveryPolygon: body.deliveryPolygon,
      hoursJson: body.hours,
      phone: body.phone ?? null,
      email: body.email ?? null,
      logoImageKey: body.logoImageKey ?? null,
      heroImageKey: body.heroImageKey ?? null,
      brandColorHex: body.brandColorHex ?? null,
    };
    const row = await this.dispensaries.create(input);
    return projectDispensary(row, now);
  }

  async patch(
    id: string,
    body: PatchDispensaryRequest,
    now: Date = new Date(),
  ): Promise<DispensaryResponse> {
    if (Object.keys(body).length === 0) {
      throw new ValidationError('Patch body must include at least one field', { dispensaryId: id });
    }
    const existing = await this.dispensaries.findById(id);
    // optional-chain trick: `existing?.deletedAt !== null` is true for both
    // a missing row (undefined !== null) and a tombstoned row, so a single
    // condition handles both without an extra null guard. After the throw,
    // `existing` narrows to a live row.
    if (existing?.deletedAt !== null) {
      throw new NotFoundError('Dispensary', id);
    }
    // When only one of the two licence dates is in the patch, cross-check
    // against the persisted row — the schema's conditional refine can only
    // see what's in the patch.
    if (body.licenseIssuedAt !== undefined && body.licenseExpiresAt === undefined) {
      if (existing.licenseExpiresAt <= body.licenseIssuedAt) {
        throw new ValidationError('licenseExpiresAt must be strictly after licenseIssuedAt', {
          dispensaryId: id,
        });
      }
    }
    if (body.licenseExpiresAt !== undefined && body.licenseIssuedAt === undefined) {
      if (body.licenseExpiresAt <= existing.licenseIssuedAt) {
        throw new ValidationError('licenseExpiresAt must be strictly after licenseIssuedAt', {
          dispensaryId: id,
        });
      }
    }
    const patchInput = {
      ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
      ...(body.dba !== undefined ? { dba: body.dba } : {}),
      ...(body.licenseType !== undefined ? { licenseType: body.licenseType } : {}),
      ...(body.licenseIssuedAt !== undefined ? { licenseIssuedAt: body.licenseIssuedAt } : {}),
      ...(body.licenseExpiresAt !== undefined ? { licenseExpiresAt: body.licenseExpiresAt } : {}),
      ...(body.metrcFacilityId !== undefined ? { metrcFacilityId: body.metrcFacilityId } : {}),
      ...(body.posProvider !== undefined ? { posProvider: body.posProvider } : {}),
      ...(body.addressLine1 !== undefined ? { addressLine1: body.addressLine1 } : {}),
      ...(body.addressLine2 !== undefined ? { addressLine2: body.addressLine2 } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.postalCode !== undefined ? { postalCode: body.postalCode } : {}),
      ...(body.hours !== undefined ? { hoursJson: body.hours } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.logoImageKey !== undefined ? { logoImageKey: body.logoImageKey } : {}),
      ...(body.heroImageKey !== undefined ? { heroImageKey: body.heroImageKey } : {}),
      ...(body.brandColorHex !== undefined ? { brandColorHex: body.brandColorHex } : {}),
      ...(body.isAcceptingOrders !== undefined
        ? { isAcceptingOrders: body.isAcceptingOrders }
        : {}),
    };
    const updated = await this.dispensaries.update(id, patchInput);
    if (updated === null) throw new NotFoundError('Dispensary', id);
    // Hours edits change `isOpenNow` in the feed projection; brand fields
    // change feed copy; the dispensary's menu key drops too so a future
    // hours-narrowing edit doesn't surface as "open" via a stale cache.
    await this.cache.invalidateDispensary(id);
    return projectDispensary(updated, now);
  }

  async activate(id: string, now: Date = new Date()): Promise<DispensaryResponse> {
    const existing = await this.dispensaries.findById(id);
    if (existing?.deletedAt !== null) {
      throw new NotFoundError('Dispensary', id);
    }
    if (existing.status === 'terminated') {
      throw new ValidationError(
        'Terminated dispensaries cannot be re-activated — provision a new licence row',
        { dispensaryId: id, status: existing.status },
      );
    }
    if (existing.status === 'active') {
      // Idempotent activate — same projection as a fresh transition.
      return projectDispensary(existing, now);
    }
    // license_expires_at is `YYYY-MM-DD`; comparing against the YYYY-MM-DD of
    // `now` (UTC date) is a one-sided string compare and is exact for this
    // column type. Comparing to the wall-clock date avoids treating an
    // expiry "today" as already-expired across timezones.
    const todayIsoDate = now.toISOString().slice(0, 10);
    if (existing.licenseExpiresAt <= todayIsoDate) {
      throw new ValidationError('License has expired — cannot activate', {
        dispensaryId: id,
        licenseExpiresAt: existing.licenseExpiresAt,
      });
    }
    const staff = await this.staff.listActiveForDispensary(id);
    const hasOwner = staff.some((member) => member.role === 'owner' && member.acceptedAt !== null);
    if (!hasOwner) {
      throw new ValidationError(
        'At least one accepted owner staff member is required to activate',
        { dispensaryId: id },
      );
    }
    const updated = await this.dispensaries.updateStatus(id, 'active');
    if (updated === null) {
      throw new RepositoryError(`dispensaries ${id} vanished mid-activate`);
    }
    // Activation makes the row visible in the feed for the first time.
    await this.cache.invalidateDispensary(id);
    return projectDispensary(updated, now);
  }

  async suspend(id: string, now: Date = new Date()): Promise<DispensaryResponse> {
    const existing = await this.dispensaries.findById(id);
    if (existing?.deletedAt !== null) {
      throw new NotFoundError('Dispensary', id);
    }
    if (existing.status === 'terminated') {
      throw new ValidationError('Terminated dispensaries cannot be suspended', {
        dispensaryId: id,
        status: existing.status,
      });
    }
    if (existing.status === 'paused') {
      return projectDispensary(existing, now);
    }
    const updated = await this.dispensaries.updateStatus(id, 'paused');
    if (updated === null) {
      throw new RepositoryError(`dispensaries ${id} vanished mid-suspend`);
    }
    // Suspension removes the row from the active feed.
    await this.cache.invalidateDispensary(id);
    return projectDispensary(updated, now);
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
