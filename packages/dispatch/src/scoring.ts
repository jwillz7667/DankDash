import { ConfigError } from '@dankdash/types';

/**
 * Pure dispatch scoring.
 *
 * Given a candidate driver — { distanceMeters, ratingAvg, ratingCount,
 * lastDeliveryAt } — and the dispatch params, returns a number in
 * [0, 1] where higher is better. The score is a weighted blend of
 * three normalised factors:
 *
 *   distance — closer to the dispensary is better. Linearly maps
 *              [0, maxRadiusMeters] → [1, 0]. Negative distances are
 *              clamped to 0 (treated as max); past max → 0 score.
 *
 *   rating   — higher 5-star average is better, weighted by review
 *              volume so a single 5-star ride from a brand-new driver
 *              does not outrank a 4.9 from a 200-delivery veteran.
 *              `null` rating (no reviews yet) gets the neutral 0.5
 *              baseline so new drivers are not starved out of dispatch
 *              entirely on day one.
 *
 *   recency  — anti-starvation. The longer it has been since the
 *              driver's last completed delivery, the higher this
 *              score, capped at `recencyHorizonMs`. `null` (never
 *              delivered) maps to 1.0 so onboarding drivers see their
 *              first offer even when veterans are present. A driver
 *              who *just* delivered scores 0 — they get the next
 *              offer last, breaking ties to spread work around.
 *
 * Weights sum to 1.0 — distance is the dominant factor (driving time
 * to the dispensary is the only one of these that affects customer
 * ETA), rating is a secondary quality signal, recency is a tertiary
 * fairness signal. The defaults in {@link DEFAULT_SCORING_PARAMS} are
 * `{ distance: 0.5, rating: 0.3, recency: 0.2 }`.
 *
 * Pure function — no clock reads (caller passes `now`), no I/O. Safe
 * to unit-test deterministically and to call inside a tight loop.
 */

export interface DispatchCandidate {
  readonly driverId: string;
  /** Beeline distance from the driver's current location to the dispensary. */
  readonly distanceMeters: number;
  /** 5-star average rating, `null` for drivers with no reviews. */
  readonly ratingAvg: number | null;
  /** Count of ratings backing `ratingAvg`. Trust-weights the rating term. */
  readonly ratingCount: number;
  /** When the driver last completed a delivery, `null` if never. */
  readonly lastDeliveryAt: Date | null;
}

export interface ScoringParams {
  /** Beyond this distance, the candidate is excluded. */
  readonly maxRadiusMeters: number;
  /** Recency caps out at this many ms — older deliveries no longer add score. */
  readonly recencyHorizonMs: number;
  /** Weights must sum to 1.0. The validator throws on construction otherwise. */
  readonly weights: {
    readonly distance: number;
    readonly rating: number;
    readonly recency: number;
  };
  /** Reviews-to-confidence half-life — at this many reviews, rating weight is
   *  half the configured `weights.rating`. Below it, rating tapers toward the
   *  neutral baseline to keep brand-new drivers from being unfairly outranked
   *  by either direction. */
  readonly ratingConfidenceHalfLife: number;
}

export const DEFAULT_SCORING_PARAMS: ScoringParams = Object.freeze({
  maxRadiusMeters: 10 * 1609.344, // 10 miles, per spec §8.3
  recencyHorizonMs: 6 * 60 * 60 * 1000, // 6 hours — typical shift length
  weights: Object.freeze({ distance: 0.5, rating: 0.3, recency: 0.2 }),
  ratingConfidenceHalfLife: 20,
});

/**
 * Score a candidate in [0, 1]. Returns `null` if the candidate is
 * outside the radius (caller should drop them rather than score 0,
 * since a 0 still beats no candidate — the caller's job is to make
 * the "no eligible drivers" signal explicit by returning null lists,
 * not zeroed scores).
 */
export function scoreCandidate(
  candidate: DispatchCandidate,
  now: Date,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
): number | null {
  if (candidate.distanceMeters < 0) {
    // Negative distance is nonsense from the SQL layer (PostGIS never
    // returns negative ST_Distance). Treat as zero — the driver is
    // standing on top of the dispensary; perfect distance score.
    candidate = { ...candidate, distanceMeters: 0 };
  }
  if (candidate.distanceMeters > params.maxRadiusMeters) return null;

  const distanceScore = 1 - candidate.distanceMeters / params.maxRadiusMeters;
  const ratingScore = ratingScoreFor(candidate, params);
  const recencyScore = recencyScoreFor(candidate, now, params);

  return (
    params.weights.distance * distanceScore +
    params.weights.rating * ratingScore +
    params.weights.recency * recencyScore
  );
}

function ratingScoreFor(candidate: DispatchCandidate, params: ScoringParams): number {
  const NEUTRAL = 0.5;
  if (candidate.ratingAvg === null || candidate.ratingCount === 0) return NEUTRAL;
  // Map 1–5 → 0–1.
  const raw = clamp01((candidate.ratingAvg - 1) / 4);
  // Confidence factor approaches 1 with more reviews; at half-life it
  // is 0.5 so a low-volume rating blends toward NEUTRAL.
  const confidence =
    candidate.ratingCount / (candidate.ratingCount + params.ratingConfidenceHalfLife);
  return raw * confidence + NEUTRAL * (1 - confidence);
}

function recencyScoreFor(candidate: DispatchCandidate, now: Date, params: ScoringParams): number {
  if (candidate.lastDeliveryAt === null) return 1; // never delivered → max
  const elapsedMs = now.getTime() - candidate.lastDeliveryAt.getTime();
  if (elapsedMs <= 0) return 0; // future timestamp / just-delivered → min
  return clamp01(elapsedMs / params.recencyHorizonMs);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export interface ScoredCandidate extends DispatchCandidate {
  readonly score: number;
}

/**
 * Score every candidate, drop those outside the radius, and sort
 * descending by score. Ties broken by driverId for deterministic
 * ordering — production never sees ties (Date.now() resolution is
 * sub-ms), but tests rely on stable order.
 *
 * `excludedDriverIds` is the set of drivers who have already declined
 * or expired this order's offers; the caller iterates by re-running
 * this function with the running blocklist instead of mutating
 * candidates in place.
 */
export function rankCandidates(
  candidates: readonly DispatchCandidate[],
  excludedDriverIds: ReadonlySet<string>,
  now: Date,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
): readonly ScoredCandidate[] {
  const ranked: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (excludedDriverIds.has(candidate.driverId)) continue;
    const score = scoreCandidate(candidate, now, params);
    if (score === null) continue;
    ranked.push({ ...candidate, score });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tiebreak: lexicographic driverId so the same input
    // always picks the same winner (UUIDv7 → newer ID later in sort
    // → older driver wins ties, which is a reasonable bias).
    return a.driverId < b.driverId ? -1 : 1;
  });
  return ranked;
}

/**
 * Convenience: pick the top candidate, or `null` if the eligible pool
 * is empty after exclusions. Equivalent to `rankCandidates(...)[0]`
 * but allocates one fewer array — the worker calls this in a loop.
 */
export function pickTopCandidate(
  candidates: readonly DispatchCandidate[],
  excludedDriverIds: ReadonlySet<string>,
  now: Date,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const candidate of candidates) {
    if (excludedDriverIds.has(candidate.driverId)) continue;
    const score = scoreCandidate(candidate, now, params);
    if (score === null) continue;
    if (best === null) {
      best = { ...candidate, score };
      continue;
    }
    if (score > best.score) {
      best = { ...candidate, score };
    } else if (score === best.score && candidate.driverId < best.driverId) {
      best = { ...candidate, score };
    }
  }
  return best;
}

/**
 * Asserts that the weights in a `ScoringParams` sum to 1.0 (within
 * floating-point tolerance). Useful when params are loaded from
 * config — a typo in env vars should fail loudly at boot instead of
 * producing a silently-skewed scorer.
 */
export function assertScoringParamsValid(params: ScoringParams): void {
  const sum = params.weights.distance + params.weights.rating + params.weights.recency;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `ScoringParams.weights must sum to 1.0, got ${sum.toFixed(6)} (distance=${
        params.weights.distance
      }, rating=${params.weights.rating}, recency=${params.weights.recency})`,
    );
  }
  if (params.maxRadiusMeters <= 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `ScoringParams.maxRadiusMeters must be > 0, got ${params.maxRadiusMeters}`,
    );
  }
  if (params.recencyHorizonMs <= 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `ScoringParams.recencyHorizonMs must be > 0, got ${params.recencyHorizonMs}`,
    );
  }
  if (params.ratingConfidenceHalfLife <= 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `ScoringParams.ratingConfidenceHalfLife must be > 0, got ${params.ratingConfidenceHalfLife}`,
    );
  }
}
