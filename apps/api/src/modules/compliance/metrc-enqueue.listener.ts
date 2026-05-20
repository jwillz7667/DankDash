/**
 * Listens for `OrderTransitionedEvent` and, on every delivery, enqueues
 * a `metric_transactions` row in `pending` for the reporting worker
 * (apps/workers) to pick up on its next 60s tick.
 *
 * Why a listener and not inline write in OrderTransitionService: the
 * Metrc submission is a cross-module side effect of the order state
 * machine — same architectural shape as the realtime push and dispatch
 * trigger described in CLAUDE.md §"Order lifecycle". The transition
 * service owns the DB chokepoint; modules like this one react to it via
 * the in-process event bus so the transition stays oblivious to who
 * cares about which state changes.
 *
 * Idempotency: `metric_transactions.order_id` is `UNIQUE`. A duplicate
 * `OrderTransitionedEvent` for the same order (e.g. a future at-least-
 * once delivery on an external bus) trips the unique violation; we map
 * SQLSTATE 23505 to a no-op and log at info level. Every other DB or
 * application error is caught and logged at error level so a listener
 * fault does not propagate back up through `OrderTransitionService.
 * emitDeferred` — the transition is already durable and the caller's
 * HTTP response must not 500 because Metrc bookkeeping had a hiccup.
 *
 * ENABLE_METRC: gated by the env flag so dev environments don't accrue
 * a backlog of pending rows nobody will process. Default is `false`
 * (Phase 0 env loader); production sets it `true` once the per-
 * dispensary credentials in `dispensaries.metric_api_key_enc` are
 * provisioned.
 *
 * Concurrency note: NestJS's EventEmitter2 `emit()` runs sync listeners
 * inline. This listener is `async` — its returned promise is NOT awaited
 * by the emit. Any work that happens after the first `await` runs on the
 * microtask queue, which means the caller's HTTP response can flush
 * before the row lands. That is intentional: Metrc reporting has a 24h
 * retry budget; the response path has a tens-of-ms one. If the listener
 * crashes mid-INSERT, the transition is durable, the event is lost, and
 * the reconciliation cron (Phase 11.4) will catch the missing receipt
 * on its next nightly sweep — exactly the safety net we built it for.
 */
import { type MetrcTransactionsRepository, type OrderItemsRepository } from '@dankdash/db';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';

interface PgUniqueViolation {
  readonly code: '23505';
}

function isUniqueViolation(err: unknown): err is PgUniqueViolation {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

export interface MetrcEnqueueListenerDeps {
  readonly orderItems: OrderItemsRepository;
  readonly metric: MetrcTransactionsRepository;
  readonly enabled: boolean;
}

@Injectable()
export class MetrcEnqueueListener {
  private readonly logger = new Logger(MetrcEnqueueListener.name);

  constructor(private readonly deps: MetrcEnqueueListenerDeps) {}

  /**
   * Single fan-out point for ORDER_TRANSITIONED_EVENT. The orders module
   * publishes one event per status flip; this method filters down to
   * `delivered` and routes to the enqueue path. Wider event ranges
   * (e.g. listening for `dispatch_failed` to mark a row failed) can hang
   * off this same hook in future phases.
   */
  @OnEvent(ORDER_TRANSITIONED_EVENT, { suppressErrors: true })
  async onOrderTransitioned(event: OrderTransitionedEvent): Promise<void> {
    if (event.toStatus !== 'delivered') return;
    if (!this.deps.enabled) {
      this.logger.debug(
        `metric disabled (ENABLE_METRC=false); skipping enqueue for order ${event.orderId}`,
      );
      return;
    }
    try {
      await this.enqueueOrder(event.orderId);
    } catch (err) {
      // Defensive catch — `isUniqueViolation` is the only expected
      // failure and is handled below. Anything else (db down, table
      // missing during a botched migration) lands here and must not
      // bubble: the event emit path discards rejected promises but Node
      // logs them as unhandled, polluting prod logs. Log + swallow.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `metric enqueue failed for order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async enqueueOrder(orderId: string): Promise<void> {
    const items = await this.deps.orderItems.listForOrder(orderId);
    // Filter out null tags — a beverage-only or otherwise-untagged
    // order surfaces an empty array. We still insert the row so the
    // failure is visible in the metric_transactions surface (the
    // worker will fail it terminal with "no package tags"), rather
    // than silently dropping it here where the only signal would be a
    // log line nobody is paged on.
    const packageTags = items
      .map((item) => item.metrcPackageTag)
      .filter((tag): tag is string => tag !== null);

    try {
      const row = await this.deps.metric.create({
        orderId,
        packageTags,
        status: 'pending',
      });
      this.logger.log(
        `metric enqueued for order ${orderId} (transaction ${row.id}, ${String(packageTags.length)} package tag(s))`,
      );
      if (packageTags.length === 0) {
        // Loud warning: every cannabis delivery should produce at least
        // one tagged package. An empty array means catalog admission
        // accepted an untagged product or items lost their tag mid-
        // flight — both are data-integrity bugs the worker will surface
        // as `failed` after its first Metrc call, but flagging here
        // gives ops a same-second signal.
        this.logger.warn(
          `metric enqueue: order ${orderId} has zero Metrc package tags — worker will fail this row terminal`,
        );
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.log(
          `metric already enqueued for order ${orderId} (duplicate ORDER_TRANSITIONED_EVENT — idempotent no-op)`,
        );
        return;
      }
      throw err;
    }
  }
}
