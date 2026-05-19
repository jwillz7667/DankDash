import { RepositoryError } from '@dankdash/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  notifications,
  pushTokens,
  type NewNotification,
  type NewPushToken,
  type Notification,
  type PushToken,
} from '../schema/notifications.js';
import { BaseRepository, newId } from './base.js';

/**
 * The `notifications` table is partitioned monthly by `created_at`. Lookups
 * by id alone are valid but Postgres must scan every partition — favour
 * filters that include the user and a date range when possible.
 */
export class NotificationsRepository extends BaseRepository {
  async listForUser(userId: string, limit = 100): Promise<readonly Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async listUnreadForUser(userId: string, limit = 100): Promise<readonly Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async create(
    input: Omit<NewNotification, 'id'> & { readonly id?: string },
  ): Promise<Notification> {
    const [row] = await this.db
      .insert(notifications)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('notifications insert returned no row');
    return row;
  }

  async markSent(id: string, providerRef: string, sentAt = new Date()): Promise<void> {
    await this.db
      .update(notifications)
      .set({ sentAt, providerRef })
      .where(eq(notifications.id, id));
  }

  async markDelivered(id: string, deliveredAt = new Date()): Promise<void> {
    await this.db.update(notifications).set({ deliveredAt }).where(eq(notifications.id, id));
  }

  async markRead(id: string, readAt = new Date()): Promise<void> {
    await this.db.update(notifications).set({ readAt }).where(eq(notifications.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.update(notifications).set({ error }).where(eq(notifications.id, id));
  }
}

export class PushTokensRepository extends BaseRepository {
  async findById(id: string): Promise<PushToken | null> {
    const [row] = await this.db.select().from(pushTokens).where(eq(pushTokens.id, id)).limit(1);
    return row ?? null;
  }

  async listActiveForUser(userId: string, appVariant?: string): Promise<readonly PushToken[]> {
    const where =
      appVariant === undefined
        ? and(eq(pushTokens.userId, userId), eq(pushTokens.isActive, true))
        : and(
            eq(pushTokens.userId, userId),
            eq(pushTokens.appVariant, appVariant),
            eq(pushTokens.isActive, true),
          );
    return this.db.select().from(pushTokens).where(where);
  }

  /**
   * Idempotent register-or-refresh by (user_id, device_id, app_variant) — when
   * a user reinstalls or rotates the APNs token, the previous row is updated
   * in place rather than orphaned.
   */
  async upsert(input: Omit<NewPushToken, 'id'> & { readonly id?: string }): Promise<PushToken> {
    const [row] = await this.db
      .insert(pushTokens)
      .values({ ...input, id: input.id ?? newId() })
      .onConflictDoUpdate({
        target: [pushTokens.userId, pushTokens.deviceId, pushTokens.appVariant],
        set: {
          apnsToken: input.apnsToken,
          platform: input.platform,
          isActive: true,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (row === undefined) throw new RepositoryError('push_tokens upsert returned no row');
    return row;
  }

  async deactivate(id: string): Promise<void> {
    await this.db
      .update(pushTokens)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(pushTokens.id, id));
  }

  async deactivateByApnsToken(apnsToken: string): Promise<number> {
    const rows = await this.db
      .update(pushTokens)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(pushTokens.apnsToken, apnsToken), eq(pushTokens.isActive, true)))
      .returning({ id: pushTokens.id });
    return rows.length;
  }
}
