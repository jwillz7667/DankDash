/**
 * Tests for the dispatch scoring layer. The thing being pinned is the
 * algorithm's behaviour at the boundaries — what gets excluded, how
 * the three factors trade off, how ties break — not specific magic
 * numbers. Where a numeric assertion is required (e.g. distance term
 * for the closer-of-two-equal-rated drivers), we assert a comparison,
 * not the absolute score, so a future weight tweak doesn't churn the
 * test file.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORING_PARAMS,
  assertScoringParamsValid,
  pickTopCandidate,
  rankCandidates,
  scoreCandidate,
  type DispatchCandidate,
  type ScoringParams,
} from './scoring.js';

const NOW = new Date('2026-05-18T19:00:00.000Z');

function makeCandidate(overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return {
    driverId: '01935f3d-0000-7000-8000-0000000000d1',
    distanceMeters: 1000,
    ratingAvg: 4.8,
    ratingCount: 50,
    lastDeliveryAt: new Date('2026-05-18T18:00:00.000Z'),
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('returns null for candidates outside the radius (caller drops them)', () => {
    const out = scoreCandidate(
      makeCandidate({ distanceMeters: DEFAULT_SCORING_PARAMS.maxRadiusMeters + 1 }),
      NOW,
    );
    expect(out).toBeNull();
  });

  it('returns a finite number in [0, 1] for an in-radius candidate', () => {
    const out = scoreCandidate(makeCandidate(), NOW);
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThanOrEqual(0);
    expect(out!).toBeLessThanOrEqual(1);
  });

  it('treats negative distance (driver standing on dispensary) as distance=0', () => {
    const onTop = scoreCandidate(makeCandidate({ distanceMeters: -5 }), NOW);
    const zero = scoreCandidate(makeCandidate({ distanceMeters: 0 }), NOW);
    expect(onTop).toBe(zero);
  });

  it('rewards closer distance — closer driver scores higher all else equal', () => {
    const near = scoreCandidate(makeCandidate({ distanceMeters: 500 }), NOW)!;
    const far = scoreCandidate(makeCandidate({ distanceMeters: 5_000 }), NOW)!;
    expect(near).toBeGreaterThan(far);
  });

  it('rewards higher rating — higher-rated driver scores higher all else equal', () => {
    const great = scoreCandidate(makeCandidate({ ratingAvg: 4.9, ratingCount: 200 }), NOW)!;
    const mid = scoreCandidate(makeCandidate({ ratingAvg: 4.0, ratingCount: 200 }), NOW)!;
    expect(great).toBeGreaterThan(mid);
  });

  it('blends low-volume rating toward neutral (one 5-star ride does not beat 4.9/200)', () => {
    const veteran = scoreCandidate(makeCandidate({ ratingAvg: 4.9, ratingCount: 200 }), NOW)!;
    const rookie = scoreCandidate(makeCandidate({ ratingAvg: 5.0, ratingCount: 1 }), NOW)!;
    expect(veteran).toBeGreaterThan(rookie);
  });

  it('treats no-reviews drivers as the neutral baseline (0.5 rating)', () => {
    const fresh = scoreCandidate(makeCandidate({ ratingAvg: null, ratingCount: 0 }), NOW)!;
    const oneStar = scoreCandidate(makeCandidate({ ratingAvg: 1.0, ratingCount: 200 }), NOW)!;
    // A fresh driver should not be dragged below a confidently 1-star
    // veteran — the neutral baseline is the whole point.
    expect(fresh).toBeGreaterThan(oneStar);
  });

  it('rewards recency — older last-delivery scores higher all else equal', () => {
    const justFinished = scoreCandidate(
      makeCandidate({ lastDeliveryAt: new Date(NOW.getTime() - 1_000) }),
      NOW,
    )!;
    const longAgo = scoreCandidate(
      makeCandidate({ lastDeliveryAt: new Date(NOW.getTime() - 5 * 3600_000) }),
      NOW,
    )!;
    expect(longAgo).toBeGreaterThan(justFinished);
  });

  it('treats never-delivered drivers as max recency (not starved out)', () => {
    const fresh = scoreCandidate(makeCandidate({ lastDeliveryAt: null }), NOW)!;
    const stale = scoreCandidate(
      makeCandidate({
        lastDeliveryAt: new Date(NOW.getTime() - 0.5 * DEFAULT_SCORING_PARAMS.recencyHorizonMs),
      }),
      NOW,
    )!;
    expect(fresh).toBeGreaterThan(stale);
  });

  it('caps recency at the horizon — older than horizon does not buy extra score', () => {
    const horizon = scoreCandidate(
      makeCandidate({
        lastDeliveryAt: new Date(NOW.getTime() - DEFAULT_SCORING_PARAMS.recencyHorizonMs),
      }),
      NOW,
    )!;
    const ancient = scoreCandidate(
      makeCandidate({
        lastDeliveryAt: new Date(NOW.getTime() - 10 * DEFAULT_SCORING_PARAMS.recencyHorizonMs),
      }),
      NOW,
    )!;
    expect(horizon).toBe(ancient);
  });

  it('handles a future last-delivery timestamp as just-delivered (recency floor)', () => {
    // Defensive: clock skew between worker + DB shouldn't crash the
    // scorer. A future-stamped delivery means "definitely fresh" → min.
    const future = scoreCandidate(
      makeCandidate({ lastDeliveryAt: new Date(NOW.getTime() + 60_000) }),
      NOW,
    );
    expect(future).not.toBeNull();
    expect(Number.isFinite(future!)).toBe(true);
  });

  it('clamps below-1.0 ratings (bad data from upstream) to the floor', () => {
    // ratingAvg < 1 shouldn't happen — the rating system is 1–5 — but
    // if a row sneaks through (legacy import, data drift), the scorer
    // must not produce a negative rating component.
    const out = scoreCandidate(makeCandidate({ ratingAvg: 0.5, ratingCount: 200 }), NOW)!;
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
  });
});

describe('rankCandidates', () => {
  it('sorts descending by score', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'far', distanceMeters: 5_000 }),
      makeCandidate({ driverId: 'near', distanceMeters: 500 }),
      makeCandidate({ driverId: 'mid', distanceMeters: 2_000 }),
    ];
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(ranked.map((c) => c.driverId)).toEqual(['near', 'mid', 'far']);
  });

  it('drops out-of-radius candidates entirely (not just last)', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({
        driverId: 'far',
        distanceMeters: DEFAULT_SCORING_PARAMS.maxRadiusMeters + 1,
      }),
      makeCandidate({ driverId: 'near', distanceMeters: 500 }),
    ];
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.driverId).toBe('near');
  });

  it('excludes already-offered drivers (decline + expire iteration)', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'a', distanceMeters: 500 }),
      makeCandidate({ driverId: 'b', distanceMeters: 600 }),
    ];
    const ranked = rankCandidates(candidates, new Set(['a']), NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.driverId).toBe('b');
  });

  it('returns empty when every candidate is either excluded or out-of-radius', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({
        driverId: 'far',
        distanceMeters: DEFAULT_SCORING_PARAMS.maxRadiusMeters + 1,
      }),
      makeCandidate({ driverId: 'excluded', distanceMeters: 500 }),
    ];
    const ranked = rankCandidates(candidates, new Set(['excluded']), NOW);
    expect(ranked).toEqual([]);
  });

  it('breaks ties on driverId lexicographically (deterministic ordering)', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'zzz', distanceMeters: 1_000 }),
      makeCandidate({ driverId: 'aaa', distanceMeters: 1_000 }),
    ];
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(ranked.map((c) => c.driverId)).toEqual(['aaa', 'zzz']);
  });

  it('tiebreaks the same way regardless of input order (no sort-stability surprise)', () => {
    // Re-runs the tiebreak test with the input order reversed. Engine
    // sort calls the comparator with whichever orientation it picks, so
    // we exercise both branches by feeding both permutations.
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'aaa', distanceMeters: 1_000 }),
      makeCandidate({ driverId: 'zzz', distanceMeters: 1_000 }),
    ];
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(ranked.map((c) => c.driverId)).toEqual(['aaa', 'zzz']);
  });

  it('keeps three-way ties in lexicographic order', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'm', distanceMeters: 1_000 }),
      makeCandidate({ driverId: 'z', distanceMeters: 1_000 }),
      makeCandidate({ driverId: 'a', distanceMeters: 1_000 }),
    ];
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(ranked.map((c) => c.driverId)).toEqual(['a', 'm', 'z']);
  });
});

describe('pickTopCandidate', () => {
  it('returns the same driver as rankCandidates[0]', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'far', distanceMeters: 5_000 }),
      makeCandidate({ driverId: 'near', distanceMeters: 500 }),
      makeCandidate({ driverId: 'mid', distanceMeters: 2_000 }),
    ];
    const top = pickTopCandidate(candidates, new Set(), NOW);
    const ranked = rankCandidates(candidates, new Set(), NOW);
    expect(top?.driverId).toBe(ranked[0]?.driverId);
  });

  it('returns null when nobody is eligible', () => {
    expect(pickTopCandidate([], new Set(), NOW)).toBeNull();
  });

  it('returns null when every candidate is excluded', () => {
    const candidates = [makeCandidate({ driverId: 'a' })];
    expect(pickTopCandidate(candidates, new Set(['a']), NOW)).toBeNull();
  });

  it('respects the same tiebreaking rule as rankCandidates', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({ driverId: 'zzz', distanceMeters: 1_000 }),
      makeCandidate({ driverId: 'aaa', distanceMeters: 1_000 }),
    ];
    const top = pickTopCandidate(candidates, new Set(), NOW);
    expect(top?.driverId).toBe('aaa');
  });

  it('skips out-of-radius candidates entirely (does not return them)', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({
        driverId: 'far',
        distanceMeters: DEFAULT_SCORING_PARAMS.maxRadiusMeters + 1,
      }),
      makeCandidate({ driverId: 'near', distanceMeters: 500 }),
    ];
    const top = pickTopCandidate(candidates, new Set(), NOW);
    expect(top?.driverId).toBe('near');
  });

  it('returns null when the only candidate is out of radius', () => {
    const candidates: DispatchCandidate[] = [
      makeCandidate({
        driverId: 'far',
        distanceMeters: DEFAULT_SCORING_PARAMS.maxRadiusMeters + 1,
      }),
    ];
    expect(pickTopCandidate(candidates, new Set(), NOW)).toBeNull();
  });
});

describe('assertScoringParamsValid', () => {
  it('accepts the default params', () => {
    expect(() => {
      assertScoringParamsValid(DEFAULT_SCORING_PARAMS);
    }).not.toThrow();
  });

  it('rejects weights that do not sum to 1', () => {
    const bad: ScoringParams = {
      ...DEFAULT_SCORING_PARAMS,
      weights: { distance: 0.7, rating: 0.3, recency: 0.2 },
    };
    expect(() => {
      assertScoringParamsValid(bad);
    }).toThrow(/sum to 1/);
  });

  it('rejects zero / negative maxRadiusMeters', () => {
    expect(() => {
      assertScoringParamsValid({ ...DEFAULT_SCORING_PARAMS, maxRadiusMeters: 0 });
    }).toThrow(/maxRadiusMeters/);
    expect(() => {
      assertScoringParamsValid({ ...DEFAULT_SCORING_PARAMS, maxRadiusMeters: -1 });
    }).toThrow(/maxRadiusMeters/);
  });

  it('rejects zero / negative recencyHorizonMs', () => {
    expect(() => {
      assertScoringParamsValid({ ...DEFAULT_SCORING_PARAMS, recencyHorizonMs: 0 });
    }).toThrow(/recencyHorizonMs/);
  });

  it('rejects zero / negative ratingConfidenceHalfLife', () => {
    expect(() => {
      assertScoringParamsValid({
        ...DEFAULT_SCORING_PARAMS,
        ratingConfidenceHalfLife: 0,
      });
    }).toThrow(/ratingConfidenceHalfLife/);
  });

  it('tolerates floating-point sum within 1e-9', () => {
    const params: ScoringParams = {
      ...DEFAULT_SCORING_PARAMS,
      weights: { distance: 0.5 + 1e-10, rating: 0.3, recency: 0.2 },
    };
    expect(() => {
      assertScoringParamsValid(params);
    }).not.toThrow();
  });
});
