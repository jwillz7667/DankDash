/**
 * Daily purge of expired `webhook_events_processed` rows.
 *
 * The Aeropay webhook controller (Phase 6.7) inserts an idempotency row
 * per delivered event with `expires_at = now + 30 days`. That 30-day TTL
 * is well beyond Aeropay's 72-hour retry window — it leaves comfortable
 * slack for operator-driven replays during an incident. Past expiry the
 * row no longer protects anything; this job range-deletes them so the
 * table stays small and the PK lookup on every webhook stays cheap.
 *
 * Why a worker cron and not pg_cron: Railway-managed Postgres doesn't
 * expose pg_cron, and we already own a worker process. Keeping cleanup
 * in app code also makes the schedule, log shape, and failure mode
 * uniform with the rest of our jobs.
 *
 * Idempotency: the DELETE is a pure range scan on `expires_at < now`. A
 * re-run within the same second is a no-op; the only state it touches
 * is rows already eligible for deletion. No locking concerns — rows are
 * inserted but never updated, so there's nothing to race with.
 */
import { type Logger } from '@dankdash/config';
import { type WebhookEventsProcessedRepository } from '@dankdash/db';

export interface WebhookEventsCleanupJobDeps {
  readonly webhookEvents: WebhookEventsProcessedRepository;
  readonly logger: Logger;
}

export interface WebhookEventsCleanupJobInput {
  readonly now: Date;
  readonly deps: WebhookEventsCleanupJobDeps;
}

export interface WebhookEventsCleanupJobSummary {
  readonly purged: number;
  readonly durationMs: number;
}

export async function runWebhookEventsCleanupJob(
  input: WebhookEventsCleanupJobInput,
): Promise<WebhookEventsCleanupJobSummary> {
  const log = input.deps.logger.child({ job: 'webhook_events_cleanup' });
  log.info({ horizon: input.now.toISOString() }, 'webhook events cleanup started');
  const startedAt = Date.now();
  const purged = await input.deps.webhookEvents.purgeExpired(input.now);
  const durationMs = Date.now() - startedAt;
  log.info({ purged, durationMs }, 'webhook events cleanup completed');
  return { purged, durationMs };
}
