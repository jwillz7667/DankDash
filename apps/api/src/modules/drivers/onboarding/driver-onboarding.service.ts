/**
 * Driver-self onboarding service (Phase 19 completion).
 *
 *   me(userId)            — GET /v1/driver/me. The driver-self
 *                           projection. Throws NotFoundError (→ 404)
 *                           when the principal has no `drivers` row; the
 *                           iOS client reads that 404 as "not a driver
 *                           yet" and routes to onboarding.
 *
 *   apply(userId, body)   — POST /v1/driver/applications. The
 *                           self-service counterpart to
 *                           AdminDriversService.create: it inserts a
 *                           PENDING `drivers` row (background check not
 *                           yet passed) and promotes the principal's
 *                           global role to `driver`, both inside one tx.
 *                           Approval is a separate, deliberate admin
 *                           action (PATCH /v1/admin/drivers/:id sets
 *                           `backgroundCheckPassedAt`) — self-apply can
 *                           never activate a driver, only enqueue one.
 *
 * Pending vs active is modelled by `backgroundCheckPassedAt`: null means
 * "applied, awaiting review"; a date means "cleared". The dispatcher
 * (Phase 8.3) already excludes drivers with a null background-check date
 * from offer assignment, so a pending self-applied driver is inert until
 * an admin clears them — they can sign in and watch the pending screen,
 * but they receive no orders.
 *
 * `apply` is idempotent on the user's driver row:
 *   - no row            → create pending + promote role (the happy path)
 *   - pending row exists → refresh the vehicle details from the latest
 *                          submission, stay pending (a re-submission)
 *   - active row exists  → no-op, report `approved` so the client
 *                          re-routes to the shift home on its next poll
 * A hard 409 here would dead-end the iOS flow (the client retries the
 * stored draft on relaunch); idempotency keeps the flow recoverable.
 *
 * Document blobs are NOT persisted here — see the DTO header. The
 * manifest is validated at the boundary; the bytes go nowhere until the
 * presigned-upload surface exists. The pending row therefore carries a
 * null `insuranceDocKey` until that surface lands and an admin (or a
 * future upload callback) populates it.
 */
import {
  DriversRepository,
  UsersRepository,
  type Database,
  type DocumentHasher,
  type NewDriver,
} from '@dankdash/db';
import { DOCUMENT_HASH_CONTEXT } from '@dankdash/db';
import { NotFoundError, RepositoryError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { projectDriver } from '../driver.projection.js';
import type { DriverResponse } from '../dto/index.js';
import type { DriverApplicationRequest, DriverApplicationResponse } from './dto/index.js';

export interface DriverOnboardingScopedRepos {
  readonly drivers: DriversRepository;
  readonly users: UsersRepository;
}
export type DriverOnboardingScopedReposFactory = (db: Database) => DriverOnboardingScopedRepos;

@Injectable()
export class DriverOnboardingService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly users: UsersRepository,
    private readonly db: Database,
    private readonly scopedReposFor: DriverOnboardingScopedReposFactory,
    private readonly hasher: DocumentHasher,
  ) {}

  async me(userId: string): Promise<DriverResponse> {
    const driver = await this.drivers.findByUserId(userId);
    if (driver === null) {
      // No driver row for this principal. The client contract reads a
      // 404 here as "signed-in user is not a driver" and routes to the
      // onboarding flow — see DriverAppAPIClient.getMe / DriverRootFeature.
      throw new NotFoundError('Driver', userId);
    }
    return projectDriver(driver);
  }

  async apply(userId: string, body: DriverApplicationRequest): Promise<DriverApplicationResponse> {
    const user = await this.users.findById(userId);
    if (user?.deletedAt !== null) {
      // The principal authenticated moments ago; a missing or tombstoned
      // user row here is a hard inconsistency, not a client error.
      throw new RepositoryError('DriverOnboardingService.apply: authenticated user not found', {
        userId,
      });
    }

    const existing = await this.drivers.findByUserId(userId);
    if (existing !== null) {
      if (existing.backgroundCheckPassedAt !== null) {
        // Already an active driver — the app routes activated drivers to
        // the shift home, so this is a stale resubmission. Report the
        // activated state and let the next `me` poll re-route the client.
        return { applicationId: existing.id, status: 'approved', queuePosition: null };
      }
      // Pending row already exists — treat the new submission as an
      // update to the vehicle details and keep the application in queue.
      // Vehicle columns are the only patchable fields the client owns;
      // license number and identity are immutable post-create.
      const updated = await this.drivers.update(existing.id, {
        vehicleMake: body.vehicleMake,
        vehicleModel: body.vehicleModel,
        vehicleYear: body.vehicleYear,
        vehiclePlate: body.vehiclePlate,
        vehicleColor: body.vehicleColor,
      });
      return {
        applicationId: updated?.id ?? existing.id,
        status: 'pending',
        queuePosition: null,
      };
    }

    const licenseNumberHash = this.hasher.hash(
      body.licenseNumber,
      DOCUMENT_HASH_CONTEXT.DRIVER_LICENSE_NUMBER,
    );

    const insertInput: Omit<NewDriver, 'id'> = {
      userId,
      licenseNumberHash,
      vehicleMake: body.vehicleMake,
      vehicleModel: body.vehicleModel,
      vehicleYear: body.vehicleYear,
      vehiclePlate: body.vehiclePlate,
      vehicleColor: body.vehicleColor,
      insuranceDocKey: null,
      insuranceExpiresAt: null,
      // Pending until an admin clears the background check. Self-apply
      // can never set this — activation is an operator-only action.
      backgroundCheckPassedAt: null,
      backgroundCheckProviderRef: null,
    };

    const created = await this.db.transaction(async (tx) => {
      const scoped = this.scopedReposFor(tx);
      const driver = await scoped.drivers.create(insertInput);
      // Re-check the user inside the tx: the pre-check ran outside it, so
      // a concurrent soft-delete between the check and the role promotion
      // would silently fail the UPDATE and leave a drivers row pointing
      // at a tombstone. If the user is gone the whole tx rolls back.
      const promoted = await scoped.users.update(userId, { role: 'driver' });
      if (promoted === null) {
        throw new RepositoryError(`DriverOnboardingService.apply: user ${userId} vanished mid-tx`, {
          userId,
        });
      }
      return driver;
    });

    return { applicationId: created.id, status: 'pending', queuePosition: null };
  }
}
