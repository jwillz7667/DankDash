/**
 * Cron wrapper around runDispatchJob.
 *
 * Schedule: `*\/5 * * * * *` — every 5 seconds. node-cron's 6-field
 * format puts seconds in the leading position; the regular 5-field
 * payout / cleanup schedules are minute-resolution.
 *
 * Why 5s: the per-driver offer budget is 30s, so a 5s tick is fine
 * enough that a freshly-expired offer + a freshly-arrived order both
 * see their next decision within one tick. Tighter ticks (1s, 2s) add
 * DB load (`listInStatus` + `findDispatchCandidatesNearDispensary` for
 * each in-flight order) without changing customer-visible latency
 * meaningfully — the iOS driver app gets the offer via the realtime
 * push (Phase 9) within ms of the worker's INSERT regardless of the
 * tick cadence.
 *
 * No timezone is needed for sub-minute cron — schedule it in UTC.
 * Setting one breaks node-cron's seconds parsing on some versions
 * (the timezone option triggers the 5-field parser path).
 *
 * `runOnInit` deliberately off — a worker restart should not double-fire
 * an immediate tick. The next 5-second tick is at most 5s away anyway.
 */
import { type ScheduledTask, schedule } from 'node-cron';
import { runDispatchJob, type DispatchJobDeps } from './dispatch.job.js';

export const DISPATCH_CRON_EXPRESSION = '*/5 * * * * *';

export function scheduleDispatchJob(deps: DispatchJobDeps): ScheduledTask {
  return schedule(DISPATCH_CRON_EXPRESSION, () => {
    void runDispatchJob({ now: new Date(), deps }).catch((err: unknown) => {
      // Tick orchestration blew up (likely the `listInStatus` query
      // itself). Log and let the next tick retry. Crashing the worker
      // would just defer the outage, and the offer-expiry job in the
      // same process would die with it — keep the process alive.
      const message = err instanceof Error ? err.message : 'unknown error';
      deps.logger.error({ err: message }, 'dispatch job orchestration failed');
    });
  });
}
