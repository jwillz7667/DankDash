/**
 * Pure payout-settlement transition logic shared by the two callers that
 * drive a `payouts` row to a terminal state:
 *
 *   1. The API's `PayoutWebhookService` — reacts to Aeropay's
 *      `payout.paid` / `payout.failed` webhooks.
 *   2. The workers' settlement-reconciliation cron — polls Aeropay for
 *      payouts stranded in `processing` when a webhook was never
 *      delivered.
 *
 * Both must apply the *identical* idempotency rule so a late webhook that
 * arrives after reconciliation (or vice-versa) is a no-op rather than a
 * clobber. Extracting the decision here keeps that rule in one place: a
 * row only advances out of `processing`, re-receiving the terminal state
 * it already holds is a benign replay, and any other current state (a
 * contradictory late event) is a conflict the caller logs and drops so a
 * terminal `completed`/`failed` is never regressed.
 *
 * Kept framework-free (no Drizzle, no NestJS) so both the API and the
 * worker — which share no runtime, only `@dankdash/db` — can consume it.
 */
import { type PayoutStatus } from '../schema/enums.js';

/** The two terminal states a processing payout can settle into. */
export type PayoutTerminalStatus = Extract<PayoutStatus, 'completed' | 'failed'>;

export type PayoutTerminalResolution =
  /** Row is still `processing` — perform the transition to `target`. */
  | { readonly kind: 'apply' }
  /** Row already holds `target` — a duplicate signal; do nothing. */
  | { readonly kind: 'replay' }
  /**
   * Row is in some other state (the opposite terminal, or a
   * pre-dispatch state) — never regress it. The caller logs for manual
   * reconciliation and drops the signal.
   */
  | { readonly kind: 'conflict' };

/**
 * Decide how to reconcile a payout's current persisted status against an
 * observed terminal outcome. Deterministic and side-effect-free — the
 * caller owns the row read and the subsequent write.
 */
export function resolvePayoutTerminalTransition(
  current: PayoutStatus,
  target: PayoutTerminalStatus,
): PayoutTerminalResolution {
  if (current === 'processing') return { kind: 'apply' };
  if (current === target) return { kind: 'replay' };
  return { kind: 'conflict' };
}
