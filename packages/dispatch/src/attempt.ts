/**
 * Per-order dispatch attempt orchestrator.
 *
 * One "attempt" is the worker's run at finding a driver for a single
 * order that has just entered `awaiting_driver`. The attempt has its
 * own time budget (`totalBudgetMs`) and offers expire on their own
 * shorter clock (`perDriverBudgetMs`). The orchestrator below is the
 * pure decision function — given the candidate pool, the offers that
 * have already been made, and `now`, it tells the worker what to do
 * next: send a new offer, wait for the current one to play out, or
 * give up and emit `DISPATCH_FAILED`.
 *
 * Why a pure state machine instead of inline logic in the worker
 * loop: the rules ("don't re-offer to someone who declined", "don't
 * exceed the total budget", "respect the per-driver expiry") are easy
 * to get wrong under concurrency. Lifting them into a pure function
 * lets the worker stay thin (DB read → consult orchestrator → DB
 * write) and gives tests a single seam to assert against.
 *
 * The worker is the only side-effect surface: it issues offers,
 * marks expirations, and triggers `DISPATCH_FAILED` on
 * `OrderTransitionService`. The orchestrator never touches a DB or a
 * clock — `now` is always passed in.
 */

import { ConfigError } from '@dankdash/types';
import { pickTopCandidate, type DispatchCandidate, type ScoringParams } from './scoring.js';

/**
 * One slot in the attempt's offer history. Mirrors what the worker
 * has persisted to `dispatch_offers` for this order. Order matters
 * only for debuggability; the orchestrator treats history as a set.
 */
export interface OfferRecord {
  readonly driverId: string;
  readonly offeredAt: Date;
  readonly expiresAt: Date;
  /**
   * `offered`     — driver was sent the offer and hasn't responded yet
   *                 (expiry might still be in the future).
   * `accepted`    — driver accepted; the attempt is done.
   * `declined`    — driver said no; driver is excluded from re-offer.
   * `expired`     — `expiresAt` passed without response; excluded.
   * `superseded`  — worker withdrew the offer (e.g. driver went
   *                 offline mid-offer). Excluded from re-offer.
   */
  readonly status: 'offered' | 'accepted' | 'declined' | 'expired' | 'superseded';
}

/**
 * Tunables for the attempt orchestrator. Defaults are spec values from
 * `DankDash-Technical-Spec.md` §8.3: 30s per-driver, 3min total.
 */
export interface AttemptParams {
  /** Budget for the whole attempt — wall-clock from `attemptStartedAt`. */
  readonly totalBudgetMs: number;
  /** How long each offer is valid before it expires. */
  readonly perDriverBudgetMs: number;
}

export const DEFAULT_ATTEMPT_PARAMS: AttemptParams = Object.freeze({
  totalBudgetMs: 3 * 60_000, // 3 minutes
  perDriverBudgetMs: 30_000, // 30 seconds
});

/**
 * One immutable snapshot of an in-flight attempt.
 */
export interface AttemptState {
  readonly orderId: string;
  /** When the attempt entered `awaiting_driver`. */
  readonly attemptStartedAt: Date;
  /** Current candidate pool from the DB (already filtered by online + radius). */
  readonly candidates: readonly DispatchCandidate[];
  /** Offers persisted so far for this attempt, in any order. */
  readonly history: readonly OfferRecord[];
  readonly params?: AttemptParams;
}

/**
 * `OFFER_NEXT`    — the orchestrator picked a new driver; the worker
 *                   should insert a `dispatch_offers` row and notify
 *                   the driver. `expiresAt` is the deadline.
 *
 * `WAIT_FOR_OFFER` — there's an offer in flight (status='offered',
 *                    `expiresAt` in the future). The worker should
 *                    sleep until `until` and reconsult.
 *
 * `ACCEPTED`      — an offer in history has `status='accepted'`. The
 *                   attempt is done; the worker should record the
 *                   driver assignment via OrderTransitionService.
 *
 * `FAILED`        — total budget exhausted OR no eligible candidates
 *                   remain. The worker should trigger
 *                   `DISPATCH_FAILED` on the order. The `reason`
 *                   distinguishes the two failure modes for telemetry.
 */
export type AttemptDecision =
  | {
      readonly kind: 'OFFER_NEXT';
      readonly driverId: string;
      readonly expiresAt: Date;
      readonly score: number;
    }
  | { readonly kind: 'WAIT_FOR_OFFER'; readonly until: Date; readonly driverId: string }
  | { readonly kind: 'ACCEPTED'; readonly driverId: string }
  | {
      readonly kind: 'FAILED';
      readonly reason: 'budget_exhausted' | 'no_eligible_drivers';
    };

/**
 * The crux. Decides what the worker should do next. No I/O, no clock —
 * callers pass `now` so tests are deterministic and the worker can
 * batch decisions across multiple orders against a single clock read.
 *
 * Decision order (intentional):
 *
 *   1. If any history row is `accepted` → ACCEPTED. Belt-and-braces:
 *      the worker shouldn't reconsult after accept, but if it does we
 *      tell it the truth instead of issuing another offer.
 *
 *   2. If there's an `offered` row whose `expiresAt > now` →
 *      WAIT_FOR_OFFER. We never have two outstanding offers per attempt
 *      — the spec is single-offer-at-a-time so the driver who accepts
 *      isn't fighting another driver who also accepted.
 *
 *   3. If `now - attemptStartedAt >= totalBudgetMs` → FAILED(budget).
 *
 *   4. Score the eligible pool (everyone except those in history's
 *      terminal statuses — declined / expired / superseded). If empty
 *      → FAILED(no_eligible_drivers). Otherwise → OFFER_NEXT.
 *
 * Why the budget check sits between (2) and (4): an offer can be
 * `offered` past the total budget if the per-driver expiry runs over
 * — in that case we honor the current offer (rule 2 short-circuits),
 * but as soon as it expires/declines, rule 3 fires and we don't
 * start a new round of offers.
 */
export function decideNextStep(
  state: AttemptState,
  now: Date,
  scoringParams?: ScoringParams,
): AttemptDecision {
  const params = state.params ?? DEFAULT_ATTEMPT_PARAMS;

  for (const offer of state.history) {
    if (offer.status === 'accepted') {
      return { kind: 'ACCEPTED', driverId: offer.driverId };
    }
  }

  const liveOffer = findLiveOffer(state.history, now);
  if (liveOffer !== null) {
    return {
      kind: 'WAIT_FOR_OFFER',
      until: liveOffer.expiresAt,
      driverId: liveOffer.driverId,
    };
  }

  if (now.getTime() - state.attemptStartedAt.getTime() >= params.totalBudgetMs) {
    return { kind: 'FAILED', reason: 'budget_exhausted' };
  }

  const excluded = excludedDriverIds(state.history);
  const top = pickTopCandidate(state.candidates, excluded, now, scoringParams);
  if (top === null) {
    return { kind: 'FAILED', reason: 'no_eligible_drivers' };
  }

  const expiresAt = new Date(now.getTime() + params.perDriverBudgetMs);
  return {
    kind: 'OFFER_NEXT',
    driverId: top.driverId,
    expiresAt,
    score: top.score,
  };
}

/**
 * Side-effect-free helper: which drivers should the scorer ignore on
 * the next pick? Any driver who has already declined, expired, or
 * been superseded for *this* attempt is out — re-offering would
 * either spam them or risk re-issuing to someone who already said no.
 * `accepted` is moot (rule 1 short-circuits before we get here), and
 * `offered` is also moot (rule 2 short-circuits) but we still treat
 * `offered` as excluded for defensive correctness in case a caller
 * mutates the state out from under us.
 */
function excludedDriverIds(history: readonly OfferRecord[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const offer of history) {
    set.add(offer.driverId);
  }
  return set;
}

function findLiveOffer(history: readonly OfferRecord[], now: Date): OfferRecord | null {
  for (const offer of history) {
    if (offer.status === 'offered' && offer.expiresAt.getTime() > now.getTime()) {
      return offer;
    }
  }
  return null;
}

/**
 * Asserts that `params` carries sensible budgets. Called at boot when
 * config-derived overrides are loaded — a misconfigured environment
 * variable should crash the process, not produce a silently-broken
 * dispatcher.
 */
export function assertAttemptParamsValid(params: AttemptParams): void {
  if (params.totalBudgetMs <= 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `AttemptParams.totalBudgetMs must be > 0, got ${params.totalBudgetMs}`,
    );
  }
  if (params.perDriverBudgetMs <= 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `AttemptParams.perDriverBudgetMs must be > 0, got ${params.perDriverBudgetMs}`,
    );
  }
  if (params.perDriverBudgetMs > params.totalBudgetMs) {
    // A per-driver budget larger than the total budget means rule 2
    // (wait for outstanding offer) could outrun rule 3 (budget
    // exhausted) by the full per-driver budget. We allow them equal
    // for the degenerate single-offer case but not strictly larger.
    throw new ConfigError(
      'CONFIG_INVALID',
      `AttemptParams.perDriverBudgetMs (${params.perDriverBudgetMs}) must not exceed totalBudgetMs (${params.totalBudgetMs})`,
    );
  }
}
