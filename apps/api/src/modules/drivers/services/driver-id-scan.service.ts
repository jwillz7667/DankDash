/**
 * DriverIdScanService — Veriff handoff orchestration for the driver app.
 *
 * Three call-sites converge here:
 *
 *   - startSession(driverUserId, orderId) → driver tapped Begin Scan.
 *     Creates a Veriff session (POST /v1/sessions), stashes the
 *     verification id on `orders.delivery_id_scan_ref`, transitions the
 *     order to `id_scan_pending` and emits an
 *     `order_id_scan_session_started` event. Returns the session
 *     payload (token + url) so iOS can launch the Veriff SDK.
 *
 *   - submitResult(driverUserId, orderId, body) → driver's SDK
 *     reported a terminal callback. The backend never trusts that
 *     callback alone; we call `veriff.getDecision(id)` and write the
 *     authoritative outcome. Idempotent on `(provider,
 *     provider_session_id)` via `AgeVerificationsRepository.recordIdempotent`
 *     so a webhook that races the SDK callback is a no-op.
 *
 *   - applyWebhookDecision(decision) → Veriff push receiver. Looks up
 *     the order by the `vendorData` (set to the order id at session
 *     creation), then routes through the same `applyDecision` write
 *     path as `submitResult`. The webhook controller mounts at
 *     `/v1/webhooks/veriff` and verifies HMAC via VeriffClient before
 *     calling this surface.
 *
 * Write semantics for applyDecision:
 *
 *   approved →
 *     1. `age_verifications` row INSERT … ON CONFLICT DO NOTHING with
 *        passed=true, context=delivery_handoff.
 *     2. `orders` row patch: delivery_id_scan_passed=true,
 *        delivery_id_scan_at=now(), delivery_id_scan_ref=verificationId.
 *     3. Status transition id_scan_pending → id_scan_passed via
 *        OrderTransitionService (Redis publish included).
 *
 *   declined →
 *     1. `age_verifications` INSERT with passed=false + failureReason.
 *     2. `orders` patch: delivery_id_scan_passed=false.
 *     3. Status transition id_scan_pending → id_scan_failed.
 *
 *   resubmission / expired / pending → recorded as a passed=false
 *     age_verifications row (so the audit trail is complete) but the
 *     order stays in id_scan_pending; the driver can re-launch the
 *     SDK without a new backend session.
 *
 * Status guards live inside the XState machine (`@dankdash/orders`):
 * DRIVER_ID_SCAN_STARTED is only legal from `arrived_at_dropoff`;
 * ID_SCAN_PASSED / ID_SCAN_FAILED are only legal from `id_scan_pending`;
 * DRIVER_ID_SCAN_RETRY is the legal re-arming edge from
 * `id_scan_failed` back to `id_scan_pending`. Two concurrent webhook
 * deliveries serialize at the row lock the OrderTransitionService
 * acquires; the second one re-reads the now-flipped status and the
 * state machine rejects the repeat transition.
 */
import {
  type AgeVerificationsRepository,
  type Database,
  type Order,
  type OrdersRepository,
  type UsersRepository,
} from '@dankdash/db';
import { ConflictError, NotFoundError } from '@dankdash/types';
import { Injectable, Logger } from '@nestjs/common';
import {
  DriverIdScanSessionResponseSchema,
  type DriverIdScanResultRequest,
  type DriverIdScanSessionResponse,
} from '../../identity-verification/dto/index.js';
import { VeriffClient, type VeriffDecision } from '../../identity-verification/veriff.client.js';
import { OrderTransitionService } from '../../orders/order-transition.service.js';

export interface DriverIdScanScopedRepos {
  readonly orders: OrdersRepository;
  readonly users: UsersRepository;
  readonly ageVerifications: AgeVerificationsRepository;
}

export type DriverIdScanScopedReposFactory = (db: Database) => DriverIdScanScopedRepos;

export interface DriverIdScanServiceConfig {
  /**
   * Absolute base URL the Veriff hosted-flow + webhook redirect to —
   * derived from the request host at boot, not from the request itself
   * (the iOS app never sees it). The webhook path is appended here.
   */
  readonly webhookBaseUrl: string;
}

@Injectable()
export class DriverIdScanService {
  private readonly logger = new Logger(DriverIdScanService.name);

  constructor(
    private readonly db: Database,
    private readonly reposFor: DriverIdScanScopedReposFactory,
    private readonly veriff: VeriffClient,
    private readonly orderTransitions: OrderTransitionService,
    private readonly config: DriverIdScanServiceConfig,
  ) {}

  async startSession(driverUserId: string, orderId: string): Promise<DriverIdScanSessionResponse> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    const customer = await scoped.users.findById(order.userId);
    if (customer === null) {
      throw new NotFoundError('Order customer', order.userId);
    }

    const person: { firstName?: string; lastName?: string } = {};
    if (customer.firstName !== null) person.firstName = customer.firstName;
    if (customer.lastName !== null) person.lastName = customer.lastName;

    const session = await this.veriff.createSession({
      orderId,
      callback: `${this.config.webhookBaseUrl}/v1/webhooks/veriff`,
      person,
    });

    // Choose the canonical event for the current order state. The
    // XState machine in @dankdash/orders defines:
    //   arrived_at_dropoff → DRIVER_ID_SCAN_STARTED → id_scan_pending
    //   id_scan_failed     → DRIVER_ID_SCAN_RETRY   → id_scan_pending
    //   id_scan_pending    → (no-op idempotent re-tap, no transition)
    // Any other state is illegal and the state machine will reject —
    // we surface that as the OrderError → ConflictError that
    // OrderTransitionService raises.
    const sessionEvent =
      order.status === 'id_scan_failed' ? 'DRIVER_ID_SCAN_RETRY' : 'DRIVER_ID_SCAN_STARTED';

    if (order.status !== 'id_scan_pending') {
      await this.orderTransitions.transition({
        orderId,
        event: sessionEvent,
        actor: { userId: driverUserId, role: 'driver' },
        payload: { verificationId: session.verificationId },
        patch: { deliveryIdScanRef: session.verificationId },
      });
    } else {
      // Idempotent re-tap from id_scan_pending — refresh the stored
      // verification id directly (no transition, no event row); the
      // Veriff SDK launches against the new session token while we
      // still match the eventual webhook back to this order via the
      // updated `delivery_id_scan_ref`.
      await scoped.orders.update(orderId, { deliveryIdScanRef: session.verificationId });
    }

    return DriverIdScanSessionResponseSchema.parse({
      verificationId: session.verificationId,
      sessionUrl: session.sessionUrl,
      sessionToken: session.sessionToken,
    });
  }

  /**
   * Driver app's submit-result path. Fetches the authoritative
   * decision from Veriff, writes the outcome idempotently, and
   * returns nothing — the controller chains `DriverOrdersService
   * .getForDriver(...)` to render the freshly-hydrated detail. Two
   * services so the orchestration here stays independent of the
   * read-side hydration (which has its own customer / dispensary
   * joins).
   */
  async submitResult(
    driverUserId: string,
    orderId: string,
    body: DriverIdScanResultRequest,
  ): Promise<void> {
    const scoped = this.reposFor(this.db);
    const order = await scoped.orders.findByIdForDriver(orderId, driverUserId);
    if (order === null) {
      throw new NotFoundError('Order', orderId);
    }
    if (order.deliveryIdScanRef !== body.verificationId) {
      // Driver reported a scan against a session we never issued for
      // this order. Refuse to write under a possibly wrong order id;
      // iOS should restart the flow via /id-scan-session.
      throw new ConflictError(
        'ID_SCAN_VERIFICATION_MISMATCH',
        'submitted verificationId does not match the order session',
        {
          orderId,
          expected: order.deliveryIdScanRef,
          received: body.verificationId,
        },
      );
    }

    const decision = await this.veriff.getDecision(body.verificationId);
    await this.applyDecision({ decision, order, actorUserId: driverUserId, actorRole: 'driver' });
  }

  /**
   * Veriff webhook entrypoint. The verifier in the controller already
   * proved HMAC + parsed the envelope; this surface looks up the
   * matching order by the verification id and routes through the same
   * write path as `submitResult`. Missing-order is logged + swallowed
   * — Veriff might fire a webhook for a session whose order has been
   * canceled or removed, and we want the 204 response to drain their
   * retry queue.
   */
  async applyWebhookDecision(decision: VeriffDecision): Promise<void> {
    if (decision.type === 'pending') {
      this.logger.warn(
        { verificationId: decision.verificationId },
        'Veriff webhook arrived in pending state — ignoring',
      );
      return;
    }

    const scoped = this.reposFor(this.db);
    let order: Order | null = null;

    // Prefer the order id that Veriff round-tripped via vendorData.
    if (decision.orderId !== null) {
      order = await scoped.orders.findById(decision.orderId);
    }
    // Fallback: lookup by stored verification id (covers the case where
    // vendorData was lost / truncated in transit).
    order ??= await scoped.orders.findByDeliveryIdScanRef(decision.verificationId);
    if (order === null) {
      this.logger.warn(
        { verificationId: decision.verificationId, orderId: decision.orderId },
        'Veriff webhook did not match any order — ignoring',
      );
      return;
    }
    if (order.deliveryIdScanRef !== decision.verificationId) {
      this.logger.warn(
        {
          orderId: order.id,
          expected: order.deliveryIdScanRef,
          received: decision.verificationId,
        },
        'Veriff webhook verification id does not match order session — ignoring',
      );
      return;
    }

    await this.applyDecision({ decision, order, actorUserId: null, actorRole: 'system' });
  }

  private async applyDecision(input: {
    readonly decision: VeriffDecision;
    readonly order: Order;
    readonly actorUserId: string | null;
    readonly actorRole: string;
  }): Promise<void> {
    const { decision, order, actorUserId, actorRole } = input;
    if (decision.type === 'pending') return;

    const scoped = this.reposFor(this.db);
    const decisionAt = new Date(decision.decisionAt);
    const passed = decision.type === 'approved';
    const failureReason =
      decision.type === 'declined' || decision.type === 'resubmission' ? decision.reason : null;

    // Step 1: idempotent age_verifications row. The unique constraint on
    // (provider, provider_session_id) makes a duplicate webhook a no-op.
    await scoped.ageVerifications.recordIdempotent({
      userId: order.userId,
      context: 'delivery_handoff',
      orderId: order.id,
      provider: 'veriff',
      providerSessionId: decision.verificationId,
      passed,
      passedAt: passed ? decisionAt : null,
      failureReason: failureReason ?? null,
    });

    // Step 2: short-circuit if the order already settled on the same
    // outcome. Two webhooks for the same approval should not produce
    // two `order_id_scan_passed` events.
    if (order.status === 'id_scan_passed' && passed) return;
    if (order.status === 'id_scan_failed' && decision.type === 'declined') return;
    if (order.status === 'delivered') {
      // Once delivered, no further id-scan transitions are meaningful.
      return;
    }

    // Step 3: transition the order. Non-terminal Veriff states
    // (resubmission / expired) keep the order in id_scan_pending —
    // the driver can re-launch the SDK without a new backend session,
    // so we just record the audit row and stop.
    //
    // ID_SCAN_PASSED / ID_SCAN_FAILED are system events in the auth
    // matrix (Veriff is the truth source); the driver's identity is
    // already preserved on the age_verifications row and in the event
    // payload below. The actor is always system here so the canonical
    // transition does not reject a driver-relayed pass/fail.
    if (decision.type === 'approved') {
      await this.orderTransitions.transition({
        orderId: order.id,
        event: 'ID_SCAN_PASSED',
        actor: { role: 'system' },
        payload: {
          verificationId: decision.verificationId,
          decisionAt: decision.decisionAt,
          code: decision.code,
          relayActorUserId: actorUserId,
          relayActorRole: actorRole,
        },
        patch: {
          deliveryIdScanPassed: true,
          deliveryIdScanAt: decisionAt,
          deliveryIdScanRef: decision.verificationId,
        },
      });
      return;
    }

    if (decision.type === 'declined') {
      await this.orderTransitions.transition({
        orderId: order.id,
        event: 'ID_SCAN_FAILED',
        actor: { role: 'system' },
        payload: {
          verificationId: decision.verificationId,
          decisionAt: decision.decisionAt,
          reason: decision.reason,
          code: decision.code,
          relayActorUserId: actorUserId,
          relayActorRole: actorRole,
        },
        patch: { deliveryIdScanPassed: false },
      });
      return;
    }

    // resubmission / expired: log only.
    this.logger.log(
      {
        orderId: order.id,
        verificationId: decision.verificationId,
        type: decision.type,
      },
      'Veriff decision did not transition order — driver can retry',
    );
  }
}
