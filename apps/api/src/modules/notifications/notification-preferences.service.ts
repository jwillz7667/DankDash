/**
 * Notification-preferences service — owns GET/PATCH on
 * /v1/me/notification-preferences.
 *
 * The surface is self-scoped: every method takes the authenticated `userId`
 * from the controller's `@CurrentUser`, and there is no `:id` path param, so
 * a caller can only ever read or write their own single row. That removes the
 * cross-user (IDOR) vector entirely — there is no other user's row to address.
 *
 *   getForUser(userId)        → effective preferences. When the user has no
 *                               row yet, returns the all-on defaults WITHOUT
 *                               creating a row (reads stay side-effect-free;
 *                               the dispatcher already treats a missing row as
 *                               deliver-everything, so a phantom row would add
 *                               nothing but write amplification on every open
 *                               of the settings screen).
 *   update(userId, patch)     → upsert the row with the provided subset of
 *                               toggles, then return the full effective shape.
 *
 * `DEFAULT_PREFERENCES` mirrors the column defaults in the
 * `notification_preferences` migration; the two must agree so the read-side
 * defaults and a fresh insert produce identical state.
 */
import { type NotificationPreference, type NotificationPreferencesRepository } from '@dankdash/db';
import { Injectable } from '@nestjs/common';
import type {
  NotificationPreferencesResponse,
  UpdateNotificationPreferencesRequest,
} from './dto/index.js';

const DEFAULT_PREFERENCES = {
  orderUpdatesEnabled: true,
  promotionsEnabled: true,
  pushEnabled: true,
  smsEnabled: true,
  emailEnabled: true,
} as const;

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly repo: NotificationPreferencesRepository) {}

  async getForUser(userId: string): Promise<NotificationPreferencesResponse> {
    const row = await this.repo.findByUserId(userId);
    if (row === null) {
      return { ...DEFAULT_PREFERENCES, updatedAt: null };
    }
    return toResponse(row);
  }

  async update(
    userId: string,
    patch: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferencesResponse> {
    const row = await this.repo.upsert({
      userId,
      ...(patch.orderUpdatesEnabled !== undefined
        ? { orderUpdatesEnabled: patch.orderUpdatesEnabled }
        : {}),
      ...(patch.promotionsEnabled !== undefined
        ? { promotionsEnabled: patch.promotionsEnabled }
        : {}),
      ...(patch.pushEnabled !== undefined ? { pushEnabled: patch.pushEnabled } : {}),
      ...(patch.smsEnabled !== undefined ? { smsEnabled: patch.smsEnabled } : {}),
      ...(patch.emailEnabled !== undefined ? { emailEnabled: patch.emailEnabled } : {}),
    });
    return toResponse(row);
  }
}

function toResponse(row: NotificationPreference): NotificationPreferencesResponse {
  return {
    orderUpdatesEnabled: row.orderUpdatesEnabled,
    promotionsEnabled: row.promotionsEnabled,
    pushEnabled: row.pushEnabled,
    smsEnabled: row.smsEnabled,
    emailEnabled: row.emailEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}
