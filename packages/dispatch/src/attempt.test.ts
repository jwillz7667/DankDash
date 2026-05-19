/**
 * Tests for the per-order attempt orchestrator. The four decision
 * kinds (OFFER_NEXT / WAIT_FOR_OFFER / ACCEPTED / FAILED) are checked
 * in isolation, then together — most regressions in dispatch come
 * from the order in which the rules fire, so the "rule-precedence"
 * suite at the bottom pins each combination explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTEMPT_PARAMS,
  assertAttemptParamsValid,
  decideNextStep,
  type AttemptDecision,
  type AttemptParams,
  type AttemptState,
  type OfferRecord,
} from './attempt.js';
import type { DispatchCandidate } from './scoring.js';

/**
 * Type-narrowing helper: assert the decision's discriminator and let
 * TypeScript narrow the union from this point on. Using
 * `expect.fail` rather than `throw new Error` so we (a) satisfy the
 * project lint rule against bare `Error` and (b) report a useful
 * mismatch message in the failure output instead of "typenarrow".
 */
function assertKind<K extends AttemptDecision['kind']>(
  decision: AttemptDecision,
  kind: K,
): asserts decision is Extract<AttemptDecision, { readonly kind: K }> {
  if (decision.kind !== kind) {
    expect.fail(`expected decision.kind=${kind}, got ${decision.kind}`);
  }
}

const NOW = new Date('2026-05-18T19:00:00.000Z');
const ATTEMPT_STARTED = new Date('2026-05-18T18:59:00.000Z'); // 60s ago
const ORDER_ID = '01935f3d-0000-7000-8000-0000000000a0';

function candidate(overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return {
    driverId: 'driver-default',
    distanceMeters: 1_000,
    ratingAvg: 4.8,
    ratingCount: 50,
    lastDeliveryAt: new Date(NOW.getTime() - 3 * 3_600_000),
    ...overrides,
  };
}

function state(overrides: Partial<AttemptState> = {}): AttemptState {
  return {
    orderId: ORDER_ID,
    attemptStartedAt: ATTEMPT_STARTED,
    candidates: [candidate()],
    history: [],
    ...overrides,
  };
}

function offer(overrides: Partial<OfferRecord> & Pick<OfferRecord, 'status'>): OfferRecord {
  return {
    driverId: 'driver-default',
    offeredAt: new Date(NOW.getTime() - 10_000),
    expiresAt: new Date(NOW.getTime() + 20_000),
    ...overrides,
  };
}

describe('decideNextStep — OFFER_NEXT', () => {
  it('issues an offer to the top candidate when history is empty', () => {
    const result = decideNextStep(state(), NOW);
    expect(result.kind).toBe('OFFER_NEXT');
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('driver-default');
  });

  it('sets expiresAt to now + perDriverBudgetMs', () => {
    const result = decideNextStep(state(), NOW);
    assertKind(result, 'OFFER_NEXT');
    expect(result.expiresAt.getTime()).toBe(
      NOW.getTime() + DEFAULT_ATTEMPT_PARAMS.perDriverBudgetMs,
    );
  });

  it('returns the scored top driver across multiple candidates', () => {
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'far', distanceMeters: 5_000 }),
      candidate({ driverId: 'near', distanceMeters: 500 }),
    ];
    const result = decideNextStep(state({ candidates }), NOW);
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('near');
  });

  it('skips drivers already in history (declined, expired, superseded)', () => {
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'declined', distanceMeters: 500 }),
      candidate({ driverId: 'fresh', distanceMeters: 600 }),
    ];
    const history: OfferRecord[] = [
      offer({
        driverId: 'declined',
        status: 'declined',
        offeredAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() - 30_000),
      }),
    ];
    const result = decideNextStep(state({ candidates, history }), NOW);
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('fresh');
  });

  it('includes a score in the OFFER_NEXT decision', () => {
    const result = decideNextStep(state(), NOW);
    assertKind(result, 'OFFER_NEXT');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('decideNextStep — WAIT_FOR_OFFER', () => {
  it('waits when an offer is live (status=offered, expiresAt > now)', () => {
    const history: OfferRecord[] = [
      offer({
        driverId: 'pending',
        status: 'offered',
        expiresAt: new Date(NOW.getTime() + 15_000),
      }),
    ];
    const result = decideNextStep(state({ history }), NOW);
    expect(result.kind).toBe('WAIT_FOR_OFFER');
    assertKind(result, 'WAIT_FOR_OFFER');
    expect(result.driverId).toBe('pending');
    expect(result.until.getTime()).toBe(NOW.getTime() + 15_000);
  });

  it('does not wait when the only offer is exactly at expiry (boundary)', () => {
    // expiresAt === now means "expired this instant". The worker
    // should mark it expired and pick again, not block on a stale
    // offer.
    const history: OfferRecord[] = [
      offer({
        driverId: 'just-expired',
        status: 'offered',
        expiresAt: NOW,
      }),
    ];
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'just-expired', distanceMeters: 500 }),
      candidate({ driverId: 'fresh', distanceMeters: 600 }),
    ];
    const result = decideNextStep(state({ history, candidates }), NOW);
    // Boundary: offer at exact expiry counts as expired, so we move on
    // — but the expired driver is in history → excluded → fresh wins.
    expect(result.kind).toBe('OFFER_NEXT');
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('fresh');
  });

  it('ignores an `offered` row whose expiry has passed (the worker forgot to mark it expired)', () => {
    const history: OfferRecord[] = [
      offer({
        driverId: 'leaked',
        status: 'offered',
        expiresAt: new Date(NOW.getTime() - 1_000),
      }),
    ];
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'leaked', distanceMeters: 500 }),
      candidate({ driverId: 'fresh', distanceMeters: 600 }),
    ];
    const result = decideNextStep(state({ history, candidates }), NOW);
    expect(result.kind).toBe('OFFER_NEXT');
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('fresh');
  });
});

describe('decideNextStep — ACCEPTED', () => {
  it('reports ACCEPTED as soon as any history row is accepted', () => {
    const history: OfferRecord[] = [
      offer({ driverId: 'a', status: 'declined' }),
      offer({ driverId: 'b', status: 'accepted' }),
    ];
    const result = decideNextStep(state({ history }), NOW);
    expect(result.kind).toBe('ACCEPTED');
    assertKind(result, 'ACCEPTED');
    expect(result.driverId).toBe('b');
  });

  it('prioritises ACCEPTED over a still-live offer in history', () => {
    // Defensive: shouldn't happen (worker withdraws on accept), but if
    // it does, we tell the truth instead of misreporting WAIT.
    const history: OfferRecord[] = [
      offer({
        driverId: 'stale',
        status: 'offered',
        expiresAt: new Date(NOW.getTime() + 10_000),
      }),
      offer({ driverId: 'accepted', status: 'accepted' }),
    ];
    const result = decideNextStep(state({ history }), NOW);
    expect(result.kind).toBe('ACCEPTED');
  });
});

describe('decideNextStep — FAILED', () => {
  it('fails with budget_exhausted when totalBudgetMs has elapsed', () => {
    const started = new Date(NOW.getTime() - DEFAULT_ATTEMPT_PARAMS.totalBudgetMs - 1_000);
    const result = decideNextStep(state({ attemptStartedAt: started }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('budget_exhausted');
  });

  it('fails with no_eligible_drivers when the candidate pool is empty', () => {
    const result = decideNextStep(state({ candidates: [] }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('no_eligible_drivers');
  });

  it('fails with no_eligible_drivers when every candidate is in history', () => {
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'a' }),
      candidate({ driverId: 'b' }),
    ];
    const history: OfferRecord[] = [
      offer({ driverId: 'a', status: 'declined' }),
      offer({ driverId: 'b', status: 'expired' }),
    ];
    const result = decideNextStep(state({ candidates, history }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('no_eligible_drivers');
  });

  it('treats a `superseded` history row the same as declined/expired (excluded)', () => {
    const candidates: DispatchCandidate[] = [candidate({ driverId: 'sup' })];
    const history: OfferRecord[] = [offer({ driverId: 'sup', status: 'superseded' })];
    const result = decideNextStep(state({ candidates, history }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('no_eligible_drivers');
  });
});

describe('decideNextStep — rule precedence', () => {
  it('ACCEPTED beats budget_exhausted', () => {
    // Even if the budget has elapsed, an accepted offer wins — the
    // driver is already committed; failing the dispatch would be a
    // worse outcome than running slightly over.
    const started = new Date(NOW.getTime() - DEFAULT_ATTEMPT_PARAMS.totalBudgetMs - 1_000);
    const history: OfferRecord[] = [offer({ driverId: 'ok', status: 'accepted' })];
    const result = decideNextStep(state({ attemptStartedAt: started, history }), NOW);
    expect(result.kind).toBe('ACCEPTED');
  });

  it('WAIT_FOR_OFFER beats budget_exhausted (honor a live offer past budget)', () => {
    // Per the orchestrator comment: an in-flight offer can outlive
    // the total budget by up to one per-driver-budget. The worker
    // keeps waiting.
    const started = new Date(NOW.getTime() - DEFAULT_ATTEMPT_PARAMS.totalBudgetMs - 1_000);
    const history: OfferRecord[] = [
      offer({
        driverId: 'in-flight',
        status: 'offered',
        expiresAt: new Date(NOW.getTime() + 10_000),
      }),
    ];
    const result = decideNextStep(state({ attemptStartedAt: started, history }), NOW);
    expect(result.kind).toBe('WAIT_FOR_OFFER');
  });

  it('budget_exhausted beats no_eligible_drivers (clearer failure mode)', () => {
    // If both fail conditions hold, prefer the budget reason — the
    // pool emptiness is downstream from "we ran out of time to find
    // anyone."
    const started = new Date(NOW.getTime() - DEFAULT_ATTEMPT_PARAMS.totalBudgetMs - 1_000);
    const result = decideNextStep(state({ attemptStartedAt: started, candidates: [] }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('budget_exhausted');
  });

  it('OFFER_NEXT fires when no offers are live and budget remains', () => {
    const history: OfferRecord[] = [
      offer({
        driverId: 'old',
        status: 'expired',
        offeredAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() - 30_000),
      }),
    ];
    const candidates: DispatchCandidate[] = [
      candidate({ driverId: 'old' }),
      candidate({ driverId: 'new', distanceMeters: 400 }),
    ];
    const result = decideNextStep(state({ history, candidates }), NOW);
    expect(result.kind).toBe('OFFER_NEXT');
    assertKind(result, 'OFFER_NEXT');
    expect(result.driverId).toBe('new');
  });
});

describe('decideNextStep — params override', () => {
  it('respects a custom totalBudgetMs supplied via state.params', () => {
    const params: AttemptParams = { totalBudgetMs: 10_000, perDriverBudgetMs: 5_000 };
    const started = new Date(NOW.getTime() - 11_000); // past the custom budget
    const result = decideNextStep(state({ attemptStartedAt: started, params }), NOW);
    expect(result.kind).toBe('FAILED');
    assertKind(result, 'FAILED');
    expect(result.reason).toBe('budget_exhausted');
  });

  it('respects a custom perDriverBudgetMs in the OFFER_NEXT expiry', () => {
    const params: AttemptParams = { totalBudgetMs: 120_000, perDriverBudgetMs: 7_000 };
    const result = decideNextStep(state({ params }), NOW);
    assertKind(result, 'OFFER_NEXT');
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 7_000);
  });
});

describe('assertAttemptParamsValid', () => {
  it('accepts the defaults', () => {
    expect(() => {
      assertAttemptParamsValid(DEFAULT_ATTEMPT_PARAMS);
    }).not.toThrow();
  });

  it('rejects non-positive totalBudgetMs', () => {
    expect(() => {
      assertAttemptParamsValid({ totalBudgetMs: 0, perDriverBudgetMs: 30_000 });
    }).toThrow(/totalBudgetMs/);
    expect(() => {
      assertAttemptParamsValid({ totalBudgetMs: -1, perDriverBudgetMs: 30_000 });
    }).toThrow(/totalBudgetMs/);
  });

  it('rejects non-positive perDriverBudgetMs', () => {
    expect(() => {
      assertAttemptParamsValid({ totalBudgetMs: 60_000, perDriverBudgetMs: 0 });
    }).toThrow(/perDriverBudgetMs/);
  });

  it('rejects perDriverBudgetMs strictly larger than totalBudgetMs', () => {
    expect(() => {
      assertAttemptParamsValid({ totalBudgetMs: 30_000, perDriverBudgetMs: 60_000 });
    }).toThrow(/exceed/);
  });

  it('allows perDriverBudgetMs equal to totalBudgetMs (single-offer attempt)', () => {
    expect(() => {
      assertAttemptParamsValid({ totalBudgetMs: 30_000, perDriverBudgetMs: 30_000 });
    }).not.toThrow();
  });
});
