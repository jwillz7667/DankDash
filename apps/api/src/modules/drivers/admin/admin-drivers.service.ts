/**
 * Admin write-side service for drivers.
 *
 *   create()  — POST /v1/admin/drivers. Two writes in one tx:
 *               (1) insert `drivers` row with HMAC(license_number) stored
 *               in `license_number_hash`; (2) promote the linked user's
 *               global role to `driver`. The user must already exist (no
 *               drive-by registration) and must not already have a
 *               drivers row — re-onboarding is a separate, explicit flow.
 *               The license-number string never leaves this service in
 *               clear: hashed, then discarded; the DB only ever sees the
 *               32-byte HMAC tag.
 *
 *   patch()   — PATCH /v1/admin/drivers/:id. Vehicle, insurance, and
 *               background-check fields only. License number and userId
 *               are not patchable here (see the DTO comment). Empty
 *               bodies are rejected so a no-op PATCH cannot generate a
 *               meaningless updated_at bump.
 *
 * Idempotency: re-issuing the same POST against a user that already has
 * a drivers row raises DRIVER_ALREADY_REGISTERED (409). The caller is
 * expected to PATCH the existing row instead. This is intentional — a
 * silent "create or update" would mask an operator who is onboarding
 * one user thinking they are creating a fresh row.
 */
import {
  DriversRepository,
  UsersRepository,
  type Database,
  type DocumentHasher,
  type NewDriver,
} from '@dankdash/db';
import { DOCUMENT_HASH_CONTEXT } from '@dankdash/db';
import { DriverError, NotFoundError, RepositoryError, ValidationError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectDriver } from '../driver.projection.js';
import type { DriverResponse } from '../dto/index.js';
import type { CreateDriverRequest, PatchDriverRequest } from './dto/index.js';

export interface AdminDriverScopedRepos {
  readonly drivers: DriversRepository;
  readonly users: UsersRepository;
}
export type AdminDriverScopedReposFactory = (db: Database) => AdminDriverScopedRepos;

@Injectable()
export class AdminDriversService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly users: UsersRepository,
    private readonly db: Database,
    private readonly scopedReposFor: AdminDriverScopedReposFactory,
    private readonly hasher: DocumentHasher,
  ) {}

  async create(body: CreateDriverRequest, now: Date = new Date()): Promise<DriverResponse> {
    const user = await this.users.findById(body.userId);
    if (user === null) throw new NotFoundError('User', body.userId);
    if (user.deletedAt !== null) throw new NotFoundError('User', body.userId);

    const existing = await this.drivers.findByUserId(body.userId);
    if (existing !== null) {
      throw new DriverError(
        'DRIVER_ALREADY_REGISTERED',
        'This user is already registered as a driver',
        { userId: body.userId, driverId: existing.id },
      );
    }

    if (body.insuranceExpiresAt !== undefined && body.insuranceExpiresAt !== null) {
      assertFutureDate(body.insuranceExpiresAt, 'insuranceExpiresAt', now);
    }
    if (body.backgroundCheckPassedAt !== undefined && body.backgroundCheckPassedAt !== null) {
      assertPastOrTodayDate(body.backgroundCheckPassedAt, 'backgroundCheckPassedAt', now);
    }

    const licenseNumberHash = this.hasher.hash(
      body.licenseNumber,
      DOCUMENT_HASH_CONTEXT.DRIVER_LICENSE_NUMBER,
    );

    const insertInput: Omit<NewDriver, 'id'> = {
      userId: body.userId,
      licenseNumberHash,
      vehicleMake: body.vehicleMake ?? null,
      vehicleModel: body.vehicleModel ?? null,
      vehicleYear: body.vehicleYear ?? null,
      vehiclePlate: body.vehiclePlate ?? null,
      vehicleColor: body.vehicleColor ?? null,
      insuranceDocKey: body.insuranceDocKey ?? null,
      insuranceExpiresAt: body.insuranceExpiresAt ?? null,
      backgroundCheckPassedAt: body.backgroundCheckPassedAt ?? null,
      backgroundCheckProviderRef: body.backgroundCheckProviderRef ?? null,
    };

    const created = await this.db.transaction(async (tx) => {
      const scoped = this.scopedReposFor(tx);
      const driver = await scoped.drivers.create(insertInput);
      // The user must still be live inside the tx — the pre-check above
      // happens outside the tx, so a concurrent soft-delete between the
      // check and the role-promotion would silently fail the UPDATE and
      // leave the drivers row pointing at a tombstone. Re-check inside
      // the tx; if it's gone, the tx rolls back.
      const promoted = await scoped.users.update(body.userId, { role: 'driver' });
      if (promoted === null) {
        throw new RepositoryError(
          `AdminDriversService.create: user ${body.userId} vanished mid-tx`,
        );
      }
      return driver;
    });

    return projectDriver(created);
  }

  async patch(
    id: string,
    body: PatchDriverRequest,
    now: Date = new Date(),
  ): Promise<DriverResponse> {
    if (Object.keys(body).length === 0) {
      throw new ValidationError('Patch body must include at least one field', { driverId: id });
    }
    const existing = await this.drivers.findById(id);
    if (existing === null) throw new NotFoundError('Driver', id);

    if (body.insuranceExpiresAt !== undefined && body.insuranceExpiresAt !== null) {
      assertFutureDate(body.insuranceExpiresAt, 'insuranceExpiresAt', now);
    }
    if (body.backgroundCheckPassedAt !== undefined && body.backgroundCheckPassedAt !== null) {
      assertPastOrTodayDate(body.backgroundCheckPassedAt, 'backgroundCheckPassedAt', now);
    }

    const patchInput = {
      ...(body.vehicleMake !== undefined ? { vehicleMake: body.vehicleMake } : {}),
      ...(body.vehicleModel !== undefined ? { vehicleModel: body.vehicleModel } : {}),
      ...(body.vehicleYear !== undefined ? { vehicleYear: body.vehicleYear } : {}),
      ...(body.vehiclePlate !== undefined ? { vehiclePlate: body.vehiclePlate } : {}),
      ...(body.vehicleColor !== undefined ? { vehicleColor: body.vehicleColor } : {}),
      ...(body.insuranceDocKey !== undefined ? { insuranceDocKey: body.insuranceDocKey } : {}),
      ...(body.insuranceExpiresAt !== undefined
        ? { insuranceExpiresAt: body.insuranceExpiresAt }
        : {}),
      ...(body.backgroundCheckPassedAt !== undefined
        ? { backgroundCheckPassedAt: body.backgroundCheckPassedAt }
        : {}),
      ...(body.backgroundCheckProviderRef !== undefined
        ? { backgroundCheckProviderRef: body.backgroundCheckProviderRef }
        : {}),
    };
    const updated = await this.drivers.update(id, patchInput);
    if (updated === null) throw new NotFoundError('Driver', id);
    return projectDriver(updated);
  }
}

function assertFutureDate(iso: string, field: string, now: Date): void {
  // Compare YYYY-MM-DD lexicographically against the UTC date of `now`.
  // For a date column, "future" means strictly after today UTC — the
  // column has no time component, so timezone arithmetic is moot.
  const todayIso = now.toISOString().slice(0, 10);
  if (iso <= todayIso) {
    throw new ValidationError(`${field} must be strictly after today`, { field, value: iso });
  }
}

function assertPastOrTodayDate(iso: string, field: string, now: Date): void {
  const todayIso = now.toISOString().slice(0, 10);
  if (iso > todayIso) {
    throw new ValidationError(`${field} cannot be in the future`, { field, value: iso });
  }
}
