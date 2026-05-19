/**
 * Repository for `webhook_events_processed` — the idempotency table that
 * lets the API short-circuit duplicate webhook deliveries without invoking
 * the handler twice.
 *
 * Two operations:
 *   - recordIfAbsent: INSERT ... ON CONFLICT DO NOTHING on the event_id
 *     primary key. The boolean `recorded` tells the caller whether this
 *     was the first delivery (true → run side effects) or a replay
 *     (false → ack the webhook, do nothing). The pre-existing row is
 *     re-selected on conflict so the caller can log who got there first
 *     (e.g. mid-incident replay vs Aeropay retry).
 *   - purgeExpired: scoped DELETE that the nightly cron uses to keep the
 *     table small. The expires_at index makes this a range scan rather
 *     than a full table walk.
 *
 * Note that this repo intentionally has no `delete by event_id` — once a
 * webhook is recorded as processed it stays that way until expiry. A
 * mid-incident "I need to replay event X" requires the operator to wait
 * for the row to expire or to update its expires_at backwards (Postgres
 * has no `TRUNCATE WHERE`, so this is by design).
 */
import { eq, lt } from 'drizzle-orm';
import {
  type NewWebhookEventProcessed,
  type WebhookEventProcessed,
  webhookEventsProcessed,
} from '../schema/webhook-events.js';
import { BaseRepository } from './base.js';

export class WebhookEventsProcessedRepository extends BaseRepository {
  async recordIfAbsent(input: {
    readonly eventId: string;
    readonly provider: string;
    readonly eventType: string;
    readonly expiresAt: Date;
  }): Promise<{ readonly recorded: boolean; readonly existing: WebhookEventProcessed | null }> {
    const candidate: NewWebhookEventProcessed = {
      eventId: input.eventId,
      provider: input.provider,
      eventType: input.eventType,
      expiresAt: input.expiresAt,
    };
    const inserted = await this.db
      .insert(webhookEventsProcessed)
      .values(candidate)
      .onConflictDoNothing({ target: webhookEventsProcessed.eventId })
      .returning();
    if (inserted[0] !== undefined) {
      return { recorded: true, existing: null };
    }
    const [existing] = await this.db
      .select()
      .from(webhookEventsProcessed)
      .where(eq(webhookEventsProcessed.eventId, input.eventId))
      .limit(1);
    return { recorded: false, existing: existing ?? null };
  }

  async findByEventId(eventId: string): Promise<WebhookEventProcessed | null> {
    const [row] = await this.db
      .select()
      .from(webhookEventsProcessed)
      .where(eq(webhookEventsProcessed.eventId, eventId))
      .limit(1);
    return row ?? null;
  }

  async purgeExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(webhookEventsProcessed)
      .where(lt(webhookEventsProcessed.expiresAt, now))
      .returning({ eventId: webhookEventsProcessed.eventId });
    return rows.length;
  }
}
