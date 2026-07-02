/**
 * Dispatch worker — Phase 8.3.
 *
 * Tick contract: for every order currently in `awaiting_driver`, decide
 * what the next dispatch step should be (issue an offer, wait for the
 * one in flight, or fail) and act on it. The decision is delegated to
 * the pure `@dankdash/dispatch` orchestrator; this file is the I/O
 * shell — it reads candidates + offer history out of Drizzle, hands
 * them to `decideNextStep`, and writes the resulting offer / status
 * transition back.
 *
 * Why polling, not Redis Streams (yet): the polling tick is the simplest
 * thing that correctly serialises against the API's offer-accept and
 * offer-decline endpoints — both edits go through the same DB row and
 * either succeed or surface as `ORDER_INVALID_TRANSITION`. Redis Streams
 * adds a second moving part (consumer groups, claim semantics) for what
 * is at most a few-second improvement in dispatch latency. Phase 9
 * (realtime) is the natural home for the cross-process event bus; once
 * that's wired the tick can become "drained by the bus, only polls as a
 * defence in depth."
 *
 * No transaction wraps the whole tick — each order's persist is its own
 * unit so a row lock on one order does not stall others. The two
 * mutations the tick performs (insert dispatch_offers, or transition
 * orders.status to dispatch_failed) are each idempotent against a
 * concurrent run: the offer insert is gated by the
 * `dispatch_offers_active_idx` partial index + the orchestrator's
 * "don't re-offer to anyone in history" rule, and the dispatch_failed
 * transition runs through `OrdersRepository.applyTransition` which
 * `SELECT … FOR UPDATE`s the order — a second worker's tick will see
 * the new status and bail out via the state machine.
 */
import { type Logger } from '@dankdash/config';
import {
  type DispatchOffer,
  type DispatchOffersRepository,
  type DriversRepository,
  type Order,
  type OrdersRepository,
} from '@dankdash/db';
import {
  DEFAULT_ATTEMPT_PARAMS,
  DEFAULT_SCORING_PARAMS,
  decideNextStep,
  type AttemptParams,
  type AttemptState,
  type DispatchCandidate,
  type OfferRecord,
  type ScoringParams,
} from '@dankdash/dispatch';
import { nextOrderState, OrderError } from '@dankdash/orders';
import { type PublishRealtimeEventInput } from '@dankdash/realtime-events';
import { RepositoryError } from '@dankdash/types';
import { uuidv7 } from 'uuidv7';

const METERS_PER_MILE = 1609.344;

export interface DispatchJobDeps {
  readonly orders: OrdersRepository;
  readonly drivers: DriversRepository;
  readonly dispatchOffers: DispatchOffersRepository;
  readonly logger: Logger;
  /** Override the default attempt params (3min total / 30s per driver). */
  readonly attemptParams?: AttemptParams;
  /** Override the default scoring params (10mi radius, weights, etc). */
  readonly scoringParams?: ScoringParams;
  /**
   * Open delivery pool. When `true`, the tick issues NO targeted
   * `dispatch_offers` — a ready order is claimable by any eligible
   * online driver via `POST /v1/driver/deliveries/:orderId/claim`. The
   * tick keeps ONLY the overall dispatch-budget safety net: an order
   * nobody claims within `attemptParams.totalBudgetMs` is transitioned
   * to `dispatch_failed`, identical to the targeted path's timeout.
   *
   * Omitted/`false` (the default for callers that don't set it, e.g.
   * the existing targeting tests) preserves the legacy single-best-
   * driver sequential offering. The worker wires this from
   * `DISPATCH_OPEN_POOL_ENABLED` (env default `true`).
   */
  readonly openPoolEnabled?: boolean;
  /**
   * Publishes an `offer:new` realtime envelope the instant a targeted
   * offer row is inserted, so the driver's app surfaces it via the
   * `/driver` socket within ms rather than on its next 10s poll. Wraps
   * `publishRealtimeEvent(redis, …)` at the composition root (the job
   * stays Redis-free for tests). Optional: when omitted the offer is
   * still persisted, no event is emitted — the driver app then falls
   * back to its poll. Only the legacy targeted path issues offers; the
   * open pool has none to announce (it uses the `delivery:claimed`
   * board fan-out instead).
   */
  readonly publish?: (input: PublishRealtimeEventInput) => Promise<string>;
  /** Test seam — defaults to uuidv7 in production wiring. */
  readonly idGen?: () => string;
}

export interface DispatchJobInput {
  readonly now: Date;
  readonly deps: DispatchJobDeps;
}

/**
 * Tick result counters. Exposed for tests + future telemetry. The
 * worker doesn't emit metrics yet — when it does, these fields are
 * the names that go on the histograms.
 */
export interface DispatchJobSummary {
  /** Total `awaiting_driver` orders the tick scanned. */
  readonly considered: number;
  /** Tick issued a new offer for this many orders. */
  readonly offered: number;
  /** Order had a live offer; tick left it alone. */
  readonly waited: number;
  /**
   * Order had no eligible driver this tick but its dispatch budget has
   * time left — left in `awaiting_driver` to retry next tick. This is
   * the healthy "waiting for a driver to come online" state, not a
   * failure; an order sits here until a driver appears or the budget
   * elapses (then it counts under `failedNoDrivers`).
   */
  readonly waitedNoCandidates: number;
  /** Order never had an eligible driver across its budget → `dispatch_failed`. */
  readonly failedNoDrivers: number;
  /** Order exhausted total budget → transitioned to `dispatch_failed`. */
  readonly failedBudgetExhausted: number;
  /** Order was in `awaiting_driver` without `awaiting_driver_at` — skipped. */
  readonly skippedMissingTimestamp: number;
  /**
   * Tick saw a history row marked `accepted` while the order was still
   * `awaiting_driver`. Means the accept happened in flight; benign,
   * next tick will see the order moved to `driver_assigned`.
   */
  readonly skippedAcceptInFlight: number;
  /** Per-order failures (DB error, transition refused) — never blocks other orders. */
  readonly errors: number;
}

export async function runDispatchJob(input: DispatchJobInput): Promise<DispatchJobSummary> {
  const { now, deps } = input;
  const log = deps.logger.child({ job: 'dispatch' });

  const awaiting = await deps.orders.listInStatus('awaiting_driver');
  const summary = {
    considered: awaiting.length,
    offered: 0,
    waited: 0,
    waitedNoCandidates: 0,
    failedNoDrivers: 0,
    failedBudgetExhausted: 0,
    skippedMissingTimestamp: 0,
    skippedAcceptInFlight: 0,
    errors: 0,
  };

  for (const order of awaiting) {
    if (order.awaitingDriverAt === null) {
      // Should be impossible — the orders.repo auto-stamps the column
      // on the awaiting_driver transition. If we see this it means a
      // direct UPDATE bypassed `applyTransition`, which is the kind of
      // bug Phase 7's spec calls out as deploy-blocking. Skip and log
      // loudly so it surfaces in the next on-call review.
      summary.skippedMissingTimestamp += 1;
      log.error(
        { orderId: order.id },
        'dispatch: order in awaiting_driver without awaiting_driver_at — skipping',
      );
      continue;
    }

    try {
      const outcome = await dispatchSingleOrder(order, order.awaitingDriverAt, now, deps);
      summary[outcome] += 1;
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error({ orderId: order.id, err: message }, 'dispatch: per-order failure');
    }
  }

  log.info({ summary }, 'dispatch tick complete');
  return summary;
}

type PerOrderOutcome =
  | 'offered'
  | 'waited'
  | 'waitedNoCandidates'
  | 'failedNoDrivers'
  | 'failedBudgetExhausted'
  | 'skippedAcceptInFlight';

async function dispatchSingleOrder(
  order: Order,
  attemptStartedAt: Date,
  now: Date,
  deps: DispatchJobDeps,
): Promise<PerOrderOutcome> {
  const scoringParams = deps.scoringParams ?? DEFAULT_SCORING_PARAMS;
  const attemptParams = deps.attemptParams ?? DEFAULT_ATTEMPT_PARAMS;

  if (deps.openPoolEnabled === true) {
    return dispatchOpenPoolOrder(order, attemptStartedAt, now, scoringParams, attemptParams, deps);
  }

  // Pull candidates + offer history in parallel — no causal dependency
  // between them, and at peak we want the dispatch latency budget spent
  // on the SQL round-trips, not on serial waiting.
  const [candidates, offers] = await Promise.all([
    deps.drivers.findDispatchCandidatesNearDispensary(
      order.dispensaryId,
      scoringParams.maxRadiusMeters,
    ),
    deps.dispatchOffers.listForOrder(order.id),
  ]);

  const state: AttemptState = {
    orderId: order.id,
    attemptStartedAt,
    candidates: candidates.map(
      (row): DispatchCandidate => ({
        driverId: row.driverId,
        distanceMeters: row.distanceMeters,
        ratingAvg: row.ratingAvg,
        ratingCount: row.ratingCount,
        lastDeliveryAt: row.lastDeliveryAt,
      }),
    ),
    history: offers.map(
      (o): OfferRecord => ({
        driverId: o.driverId,
        offeredAt: o.offeredAt,
        expiresAt: o.expiresAt,
        // dispatch_offers.status enum is offered/accepted/declined/expired;
        // `@dankdash/dispatch` also models 'superseded' but we never write it
        // from this side. Pass-through is exhaustive over the DB enum.
        status: o.status,
      }),
    ),
    params: attemptParams,
  };

  const decision = decideNextStep(state, now, scoringParams);

  switch (decision.kind) {
    case 'OFFER_NEXT':
      await persistOffer(order, decision.driverId, decision.expiresAt, candidates, now, deps);
      return 'offered';

    case 'WAIT_FOR_OFFER':
      return 'waited';

    case 'WAIT_FOR_CANDIDATES':
      // No eligible driver this tick, but the dispatch budget still has
      // time. Leave the order in awaiting_driver; the next tick re-runs
      // the candidate query, so a driver who comes online or drives into
      // range before `decision.until` gets the offer. No DB write — the
      // order stays put. Logged at debug to keep the tick quiet while an
      // order legitimately waits out a thin driver pool.
      deps.logger.debug(
        { orderId: order.id, until: decision.until },
        'dispatch: no eligible driver this tick — waiting within budget',
      );
      return 'waitedNoCandidates';

    case 'ACCEPTED':
      // The offer-accept endpoint runs synchronously: it locks the row,
      // marks the offer accepted, and transitions the order to
      // driver_assigned in the same tx. If we observe ACCEPTED on an
      // order still in awaiting_driver, the accept tx must have started
      // after our `listInStatus` snapshot — by next tick the order will
      // be in driver_assigned and we won't see it. Benign; log at info.
      deps.logger.info(
        { orderId: order.id, driverId: decision.driverId },
        'dispatch: ACCEPTED decision on awaiting_driver — accept in flight, next tick will reconcile',
      );
      return 'skippedAcceptInFlight';

    case 'FAILED':
      await failOrder(order, decision.reason, deps);
      return decision.reason === 'no_eligible_drivers'
        ? 'failedNoDrivers'
        : 'failedBudgetExhausted';
  }
}

/**
 * Open-pool tick for one order. The worker issues no offers — the
 * order sits on the shared `awaiting_driver` board and any eligible
 * online driver claims it via the driver API. The ONLY thing the tick
 * still owns is the dispatch-budget safety net: if the order has waited
 * past `totalBudgetMs` with no claim, transition it to `dispatch_failed`
 * so it doesn't hang forever.
 *
 * The failure reason is read off the current candidate pool (queried
 * only at the moment of failure, not every tick) so telemetry keeps the
 * same `no_eligible_drivers` vs `budget_exhausted` split the targeted
 * path emits: an empty pool at timeout means nobody was ever in range;
 * a non-empty pool means drivers were available but none claimed.
 */
async function dispatchOpenPoolOrder(
  order: Order,
  attemptStartedAt: Date,
  now: Date,
  scoringParams: ScoringParams,
  attemptParams: AttemptParams,
  deps: DispatchJobDeps,
): Promise<PerOrderOutcome> {
  const budgetDeadline = new Date(attemptStartedAt.getTime() + attemptParams.totalBudgetMs);
  if (now.getTime() < budgetDeadline.getTime()) {
    // Still within the dispatch window — leave the order on the open
    // board for a driver to claim. No DB write; the next tick re-checks.
    deps.logger.debug(
      { orderId: order.id, until: budgetDeadline },
      'dispatch: open pool — awaiting a claim within budget',
    );
    return 'waitedNoCandidates';
  }

  const candidates = await deps.drivers.findDispatchCandidatesNearDispensary(
    order.dispensaryId,
    scoringParams.maxRadiusMeters,
  );
  const reason = candidates.length === 0 ? 'no_eligible_drivers' : 'budget_exhausted';
  await failOrder(order, reason, deps);
  return reason === 'no_eligible_drivers' ? 'failedNoDrivers' : 'failedBudgetExhausted';
}

async function persistOffer(
  order: Order,
  driverId: string,
  expiresAt: Date,
  candidates: readonly { readonly driverId: string; readonly distanceMeters: number }[],
  now: Date,
  deps: DispatchJobDeps,
): Promise<void> {
  // Re-find the candidate so the persisted distance matches the one the
  // scorer used. The orchestrator already chose this driverId from the
  // same array, so the find is guaranteed; the explicit guard exists for
  // an impossible-but-clear failure mode if the orchestrator regresses.
  const candidate = candidates.find((c) => c.driverId === driverId);
  if (candidate === undefined) {
    throw new RepositoryError(
      `dispatch: OFFER_NEXT picked driver ${driverId} not present in candidates — orchestrator/repo invariant broken`,
      { driverId, candidateCount: candidates.length },
    );
  }
  const distanceMiles = (candidate.distanceMeters / METERS_PER_MILE).toFixed(2);

  // Phase 8.3 estimate: delivery fee + tip. The actual payout (Phase 6.6
  // ledger) layers on per-mile reimbursement computed from the real
  // route after delivery completes; the offer is just a preview the
  // driver sees before accepting. Keeping the formula simple and
  // commented avoids the "is this the real payout?" confusion when ops
  // reads a `dispatch_offers` row.
  const payoutEstimateCents = order.deliveryFeeCents + order.driverTipCents;

  const offer = await deps.dispatchOffers.create({
    orderId: order.id,
    driverId,
    offeredAt: now,
    expiresAt,
    payoutEstimateCents,
    distanceMiles,
    status: 'offered',
  });

  deps.logger.info(
    { orderId: order.id, driverId, expiresAt, payoutEstimateCents, distanceMiles },
    'dispatch: offer issued',
  );

  await publishOfferNew(offer, now, deps);
}

/**
 * Announce a freshly-inserted offer to its targeted driver over the
 * `/driver` realtime namespace. A publish failure is logged and
 * swallowed — the offer row is already committed and the driver app's
 * 10s poll re-surfaces it, so a lost push is UX latency, not a lost
 * offer. Never rethrows into the per-order tick.
 */
async function publishOfferNew(
  offer: DispatchOffer,
  now: Date,
  deps: DispatchJobDeps,
): Promise<void> {
  const publish = deps.publish;
  if (publish === undefined) return;
  const idGen = deps.idGen ?? uuidv7;

  try {
    await publish({
      id: idGen(),
      emittedAt: now.toISOString(),
      source: 'workers',
      event: {
        type: 'offer:new',
        payload: {
          offerId: offer.id,
          orderId: offer.orderId,
          driverId: offer.driverId,
          expiresAt: offer.expiresAt.toISOString(),
          payoutEstimateCents: offer.payoutEstimateCents,
          // NUMERIC(6,2) comes back as a string from Drizzle — coerce so
          // the realtime schema's `distanceMiles: number` validator passes.
          distanceMiles: Number(offer.distanceMiles),
        },
      },
    });
  } catch (err) {
    deps.logger.warn(
      {
        event: 'dispatch.offer_new_publish_failed',
        offerId: offer.id,
        orderId: offer.orderId,
        err: err instanceof Error ? err.message : String(err),
      },
      'dispatch: offer:new publish failed — driver app falls back to poll',
    );
  }
}

async function failOrder(
  order: Order,
  reason: 'budget_exhausted' | 'no_eligible_drivers',
  deps: DispatchJobDeps,
): Promise<void> {
  // applyTransition acquires SELECT … FOR UPDATE on the order row, then
  // runs our resolver. If a concurrent transition (driver accept,
  // customer cancel, store cancel) flipped the status between
  // `listInStatus` and the lock, the resolver throws
  // ORDER_INVALID_TRANSITION and the tx rolls back — exactly what we
  // want. Catch + log so the per-order failure does not abort the tick.
  try {
    await deps.orders.applyTransition(order.id, (locked) => {
      if (locked.status !== 'awaiting_driver') {
        throw OrderError.invalidTransition(locked.status, 'DISPATCH_FAILED');
      }
      return {
        toStatus: nextOrderState(locked.status, 'DISPATCH_FAILED'),
        eventType: 'DISPATCH_FAILED',
        actorRole: 'system',
        payload: { reason },
        reason: `dispatch failed: ${reason}`,
      };
    });
    deps.logger.info({ orderId: order.id, reason }, 'dispatch: order marked dispatch_failed');
  } catch (err) {
    if (err instanceof OrderError) {
      // Concurrent transition won the race — order is no longer ours
      // to fail. Log and let the next tick re-evaluate (it won't see
      // the order in awaiting_driver anymore).
      deps.logger.info(
        { orderId: order.id, code: err.code, reason },
        'dispatch: DISPATCH_FAILED skipped — order moved out of awaiting_driver',
      );
      return;
    }
    throw err;
  }
}
