/**
 * `@dankdash/dispatch` public surface.
 *
 * Pure dispatch logic — no NestJS, no Drizzle, no Socket.io. Two
 * layers live here:
 *
 *  - `scoring`  — given a list of candidate drivers, pick the best
 *                 one. Deterministic, side-effect-free, 100% tested.
 *  - `attempt`  — per-order orchestrator that decides what the worker
 *                 should do next: send an offer, wait for the
 *                 in-flight one, or fail.
 *
 * Worker + API code consume this through the barrel only. Deep imports
 * across the package boundary are forbidden per the monorepo rules.
 */

export {
  DEFAULT_SCORING_PARAMS,
  assertScoringParamsValid,
  pickTopCandidate,
  rankCandidates,
  scoreCandidate,
} from './scoring.js';
export type { DispatchCandidate, ScoredCandidate, ScoringParams } from './scoring.js';
export { DEFAULT_ATTEMPT_PARAMS, assertAttemptParamsValid, decideNextStep } from './attempt.js';
export type { AttemptDecision, AttemptParams, AttemptState, OfferRecord } from './attempt.js';
