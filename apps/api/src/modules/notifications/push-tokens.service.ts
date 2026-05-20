/**
 * Push-tokens service — owns POST/DELETE on /v1/me/push-tokens.
 *
 * Two responsibilities, kept narrow:
 *
 *   1. **Register-or-refresh** a token. The repository's `upsert` is keyed
 *      on `(user_id, device_id, app_variant)` and either inserts a new row
 *      or refreshes `apns_token` + flips `is_active` back to true if a
 *      previous row had been deactivated. Idempotent by design — the iOS
 *      client may re-register on every cold launch and the table stays
 *      stable at one row per device per app.
 *
 *   2. **Deactivate** by id. We never hard-delete: the dispatcher uses
 *      `is_active` as the filter so a deactivated row is invisible to
 *      sends but still queryable for support diagnostics. The caller must
 *      own the row — cross-user deactivation surfaces as 404 (same as
 *      "does not exist") so a probing client cannot enumerate token ids.
 *
 * The APNs-rejection path that flips `is_active` to false on a
 * `BadDeviceToken` reply lives in the dispatcher (Phase 12.5), not here:
 * the user is unaware their token went bad and the iOS app re-registers
 * on next launch.
 */
import { type PushToken, type PushTokensRepository } from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type {
  PushTokenResponse,
  RegisterPushTokenRequest,
  RegisterPushTokenResponse,
} from './dto/index.js';

@Injectable()
export class PushTokensService {
  constructor(private readonly repo: PushTokensRepository) {}

  async register(
    userId: string,
    input: RegisterPushTokenRequest,
  ): Promise<RegisterPushTokenResponse> {
    const row = await this.repo.upsert({
      userId,
      deviceId: input.deviceId,
      apnsToken: input.apnsToken,
      platform: input.platform,
      appVariant: input.appVariant,
      isActive: true,
    });
    return { pushToken: toResponse(row) };
  }

  async deactivate(userId: string, id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (row?.userId !== userId) {
      throw new NotFoundError('push_token', id);
    }
    if (!row.isActive) {
      // Idempotent: deactivating a deactivated row is a no-op and still
      // returns 204. iOS retry-on-network-flake should not surface a 4xx
      // to the user.
      return;
    }
    await this.repo.deactivate(id);
  }
}

function toResponse(row: PushToken): PushTokenResponse {
  return {
    id: row.id,
    deviceId: row.deviceId,
    platform: row.platform as PushTokenResponse['platform'],
    appVariant: row.appVariant as PushTokenResponse['appVariant'],
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
