/**
 * Unit tests for DriverIdScanService — the Veriff handoff orchestration.
 *
 * Coverage:
 *
 *   startSession
 *     - Happy path: finds the order, looks up the customer, calls
 *       VeriffClient.createSession, transitions the order to
 *       `id_scan_pending` with `patch.deliveryIdScanRef` and
 *       `expectedFromStatus` covering the legitimate predecessor set,
 *       returns the session payload.
 *     - NotFoundError when the driver does not own the order (the
 *       repo seam returns null for both unknown ids and cross-driver
 *       ids — the service must not distinguish).
 *     - NotFoundError when the customer row is missing.
 *
 *   submitResult
 *     - Happy path: calls veriff.getDecision, records an ageVerifications
 *       row, transitions to id_scan_passed with the patch + correct
 *       actorRole.
 *     - NotFoundError when the driver does not own the order.
 *     - ConflictError('ID_SCAN_VERIFICATION_MISMATCH') when the body
 *       verificationId does not match the row's `deliveryIdScanRef`.
 *
 *   applyWebhookDecision
 *     - Approved path: prefers `decision.orderId`, validates that the
 *       row's `deliveryIdScanRef` matches, transitions to
 *       id_scan_passed with `actorRole='system'` and NO actorUserId.
 *     - Declined path: transitions to id_scan_failed; same actor shape.
 *     - Idempotency: approved + order already in id_scan_passed →
 *       ageVerifications row is still recorded (audit trail) but the
 *       transition is skipped.
 *     - Mismatched verificationId on order → logs + drops (no transition,
 *       no ageVerifications insert).
 *     - Missing order → logs + drops (Veriff retries drain on 2xx).
 *     - `pending` decision → no-op (webhook should never fire on pending,
 *       but the guard exists).
 *     - `resubmission` decision → ageVerifications row recorded but the
 *       order stays in id_scan_pending (no transition).
 *
 * VeriffClient, OrderTransitionService, and the three repositories are hand-
 * rolled fakes. No HTTP, no DB.
 */
import { ConflictError, NotFoundError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriverIdScanService, type DriverIdScanScopedRepos } from './driver-id-scan.service.js';
import type { VeriffClient, VeriffDecision } from '../../identity-verification/veriff.client.js';
import type { OrderTransitionService } from '../../orders/order-transition.service.js';
import type {
  AgeVerification,
  AgeVerificationsRepository,
  Database,
  NewAgeVerification,
  Order,
  OrderStatusTransitionInput,
  OrdersRepository,
  User,
  UsersRepository,
} from '@dankdash/db';

const DRIVER_USER_ID = '01935f3d-0000-7000-8000-000000000a01';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000a10';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000a20';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000a30';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-000000000a40';
const VERIFICATION_ID = '01935f3d-0000-7000-8000-000000000aa0';
const SESSION_URL = 'https://magic.veriff.me/v/01935f3d-0000-7000-8000-000000000aa0';
const SESSION_TOKEN = 'tok_test_01935f3d_aa0';
const WEBHOOK_BASE_URL = 'https://api.dankdash.com';
const FAKE_DB = {} as Database;

const SAMPLE_SNAPSHOT = {
  id: ADDRESS_ID,
  label: 'Home',
  line1: '345 Park Ave',
  line2: 'Apt 4B',
  city: 'St Paul',
  region: 'MN',
  postalCode: '55102',
  country: 'US',
  location: { type: 'Point' as const, coordinates: [-93.094, 44.953] as const },
  deliveryInstructions: 'Leave with doorman',
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'ABC123',
    userId: CUSTOMER_ID,
    dispensaryId: DISPENSARY_ID,
    deliveryAddressId: ADDRESS_ID,
    driverId: DRIVER_USER_ID,
    status: 'arrived_at_dropoff',
    statusChangedAt: new Date('2026-05-15T20:30:00.000Z'),
    subtotalCents: 5000,
    cannabisTaxCents: 500,
    salesTaxCents: 300,
    deliveryFeeCents: 500,
    driverTipCents: 200,
    discountCents: 0,
    totalCents: 6500,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: SAMPLE_SNAPSHOT,
    placedAt: new Date('2026-05-15T18:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: new Date('2026-05-15T18:05:00.000Z'),
    rejectedAt: null,
    preppingAt: new Date('2026-05-15T18:10:00.000Z'),
    preparedAt: new Date('2026-05-15T18:30:00.000Z'),
    awaitingDriverAt: new Date('2026-05-15T18:31:00.000Z'),
    dispatchFailedAt: null,
    driverAssignedAt: new Date('2026-05-15T18:35:00.000Z'),
    enRoutePickupAt: new Date('2026-05-15T19:00:00.000Z'),
    pickedUpAt: new Date('2026-05-15T19:30:00.000Z'),
    enRouteDropoffAt: new Date('2026-05-15T19:45:00.000Z'),
    arrivedAtDropoffAt: new Date('2026-05-15T20:30:00.000Z'),
    idScanPendingAt: null,
    deliveredAt: null,
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: null,
    deliveryIdScanPassed: null,
    deliveryIdScanAt: null,
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: new Date('2026-05-15T18:00:00.000Z'),
    updatedAt: new Date('2026-05-15T20:30:00.000Z'),
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<User> = {}): User {
  return {
    id: CUSTOMER_ID,
    email: 'sam@example.com',
    phone: '+16125554321',
    passwordHash: 'argon2id$placeholder',
    role: 'customer',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Jenkins',
    dateOfBirth: '1996-01-01',
    kycVerifiedAt: new Date('2025-06-01T12:00:00.000Z'),
    kycProvider: 'veriff',
    kycProviderRef: 'veriff-ref-001',
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

class FakeOrdersRepo implements Pick<
  OrdersRepository,
  'findByIdForDriver' | 'findById' | 'findByDeliveryIdScanRef'
> {
  public rows = new Map<string, Order>();
  public rowsByRef = new Map<string, Order>();
  public findByIdForDriverCalls: { orderId: string; driverUserId: string }[] = [];
  public findByIdCalls: string[] = [];
  public findByRefCalls: string[] = [];

  seedForDriver(row: Order): void {
    this.rows.set(`${row.id}:${row.driverId ?? ''}`, row);
    this.rows.set(row.id, row);
    if (row.deliveryIdScanRef !== null) this.rowsByRef.set(row.deliveryIdScanRef, row);
  }

  findByIdForDriver(orderId: string, driverUserId: string): Promise<Order | null> {
    this.findByIdForDriverCalls.push({ orderId, driverUserId });
    return Promise.resolve(this.rows.get(`${orderId}:${driverUserId}`) ?? null);
  }

  findById(id: string): Promise<Order | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByDeliveryIdScanRef(ref: string): Promise<Order | null> {
    this.findByRefCalls.push(ref);
    return Promise.resolve(this.rowsByRef.get(ref) ?? null);
  }
}

class FakeUsersRepo implements Pick<UsersRepository, 'findById'> {
  public rows = new Map<string, User>();
  seed(row: User): void {
    this.rows.set(row.id, row);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
}

class FakeAgeVerificationsRepo implements Pick<AgeVerificationsRepository, 'recordIdempotent'> {
  public records: (Omit<NewAgeVerification, 'id'> & { readonly id?: string })[] = [];

  recordIdempotent(
    input: Omit<NewAgeVerification, 'id'> & { readonly id?: string },
  ): Promise<AgeVerification> {
    this.records.push(input);
    const row: AgeVerification = {
      id: input.id ?? `av_${this.records.length}`,
      userId: input.userId,
      context: input.context,
      orderId: input.orderId ?? null,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      passed: input.passed,
      passedAt: input.passedAt ?? null,
      failureReason: input.failureReason ?? null,
      scanImageKey: input.scanImageKey ?? null,
      selfieImageKey: input.selfieImageKey ?? null,
      documentDobValue: input.documentDobValue ?? null,
      createdAt: new Date('2026-05-15T21:00:00.000Z'),
    };
    return Promise.resolve(row);
  }
}

class FakeVeriffClient {
  public createSessionCalls: Parameters<VeriffClient['createSession']>[0][] = [];
  public getDecisionCalls: string[] = [];
  public nextDecision: VeriffDecision = {
    type: 'approved',
    verificationId: VERIFICATION_ID,
    orderId: ORDER_ID,
    decisionAt: '2026-05-15T21:00:00.000Z',
    code: 9001,
  };

  createSession = (
    input: Parameters<VeriffClient['createSession']>[0],
  ): ReturnType<VeriffClient['createSession']> => {
    this.createSessionCalls.push(input);
    return Promise.resolve({
      verificationId: VERIFICATION_ID,
      sessionUrl: SESSION_URL,
      sessionToken: SESSION_TOKEN,
    });
  };

  getDecision = (verificationId: string): ReturnType<VeriffClient['getDecision']> => {
    this.getDecisionCalls.push(verificationId);
    return Promise.resolve(this.nextDecision);
  };
}

class FakeOrderTransitionService {
  public calls: OrderStatusTransitionInput[] = [];
  public throwError: Error | null = null;

  constructor(private readonly orders: FakeOrdersRepo) {}

  transition = (input: OrderStatusTransitionInput): Promise<Order> => {
    this.calls.push(input);
    if (this.throwError !== null) return Promise.reject(this.throwError);
    const existing =
      this.orders.rows.get(`${input.orderId}:${DRIVER_USER_ID}`) ??
      this.orders.rows.get(input.orderId);
    if (existing === undefined) {
      return Promise.reject(new Error(`fake transition: order ${input.orderId} not seeded`));
    }
    const next = {
      ...existing,
      status: input.toStatus,
      statusChangedAt: new Date('2026-05-15T21:00:00.000Z'),
      ...input.patch,
    } as Order;
    this.orders.rows.set(`${input.orderId}:${DRIVER_USER_ID}`, next);
    this.orders.rows.set(input.orderId, next);
    return Promise.resolve(next);
  };
}

interface Rig {
  readonly service: DriverIdScanService;
  readonly orders: FakeOrdersRepo;
  readonly users: FakeUsersRepo;
  readonly ageVerifications: FakeAgeVerificationsRepo;
  readonly veriff: FakeVeriffClient;
  readonly events: FakeOrderTransitionService;
}

function makeRig(): Rig {
  const orders = new FakeOrdersRepo();
  const users = new FakeUsersRepo();
  const ageVerifications = new FakeAgeVerificationsRepo();
  const veriff = new FakeVeriffClient();
  const events = new FakeOrderTransitionService(orders);
  const scoped: DriverIdScanScopedRepos = {
    orders: orders as unknown as OrdersRepository,
    users: users as unknown as UsersRepository,
    ageVerifications: ageVerifications as unknown as AgeVerificationsRepository,
  };
  const service = new DriverIdScanService(
    FAKE_DB,
    () => scoped,
    veriff as unknown as VeriffClient,
    events as unknown as OrderTransitionService,
    { webhookBaseUrl: WEBHOOK_BASE_URL },
  );
  return { service, orders, users, ageVerifications, veriff, events };
}

describe('DriverIdScanService.startSession', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('creates a Veriff session, transitions to id_scan_pending with the verification id patch, returns the payload', async () => {
    rig.orders.seedForDriver(makeOrder());
    rig.users.seed(makeCustomer());

    const out = await rig.service.startSession(DRIVER_USER_ID, ORDER_ID);

    expect(rig.veriff.createSessionCalls).toHaveLength(1);
    const veriffCall = rig.veriff.createSessionCalls[0]!;
    expect(veriffCall.orderId).toBe(ORDER_ID);
    expect(veriffCall.callback).toBe(`${WEBHOOK_BASE_URL}/v1/webhooks/veriff`);
    expect(veriffCall.person).toEqual({ firstName: 'Sam', lastName: 'Jenkins' });

    expect(rig.events.calls).toHaveLength(1);
    const transition = rig.events.calls[0]!;
    expect(transition.orderId).toBe(ORDER_ID);
    expect(transition.toStatus).toBe('id_scan_pending');
    expect(transition.eventType).toBe('order_id_scan_session_started');
    expect(transition.actorUserId).toBe(DRIVER_USER_ID);
    expect(transition.actorRole).toBe('driver');
    expect(transition.payload).toEqual({ verificationId: VERIFICATION_ID });
    expect(transition.patch).toEqual({ deliveryIdScanRef: VERIFICATION_ID });
    expect(transition.expectedFromStatus).toEqual([
      'arrived_at_dropoff',
      'en_route_dropoff',
      'id_scan_pending',
      'id_scan_failed',
    ]);

    expect(out).toEqual({
      verificationId: VERIFICATION_ID,
      sessionUrl: SESSION_URL,
      sessionToken: SESSION_TOKEN,
    });
  });

  it('throws NotFoundError without calling Veriff when the driver does not own the order', async () => {
    rig.users.seed(makeCustomer());

    await expect(rig.service.startSession(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.veriff.createSessionCalls).toHaveLength(0);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('throws NotFoundError when the customer row is missing', async () => {
    rig.orders.seedForDriver(makeOrder());
    // No customer seeded.

    await expect(rig.service.startSession(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.veriff.createSessionCalls).toHaveLength(0);
  });

  it('omits the firstName/lastName when the customer has null name fields', async () => {
    rig.orders.seedForDriver(makeOrder());
    rig.users.seed(makeCustomer({ firstName: null, lastName: null }));

    await rig.service.startSession(DRIVER_USER_ID, ORDER_ID);

    expect(rig.veriff.createSessionCalls[0]!.person).toEqual({});
  });
});

describe('DriverIdScanService.submitResult', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('approved happy path: records ageVerifications + transitions to id_scan_passed', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );
    rig.veriff.nextDecision = {
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    };

    await rig.service.submitResult(DRIVER_USER_ID, ORDER_ID, {
      verificationId: VERIFICATION_ID,
    });

    expect(rig.veriff.getDecisionCalls).toEqual([VERIFICATION_ID]);
    expect(rig.ageVerifications.records).toHaveLength(1);
    const av = rig.ageVerifications.records[0]!;
    expect(av.userId).toBe(CUSTOMER_ID);
    expect(av.context).toBe('delivery_handoff');
    expect(av.orderId).toBe(ORDER_ID);
    expect(av.provider).toBe('veriff');
    expect(av.providerSessionId).toBe(VERIFICATION_ID);
    expect(av.passed).toBe(true);
    expect(av.passedAt).toEqual(new Date('2026-05-15T21:00:00.000Z'));
    expect(av.failureReason).toBeNull();

    expect(rig.events.calls).toHaveLength(1);
    const transition = rig.events.calls[0]!;
    expect(transition.toStatus).toBe('id_scan_passed');
    expect(transition.eventType).toBe('order_id_scan_passed');
    expect(transition.actorUserId).toBe(DRIVER_USER_ID);
    expect(transition.actorRole).toBe('driver');
    expect(transition.patch).toEqual({
      deliveryIdScanPassed: true,
      deliveryIdScanAt: new Date('2026-05-15T21:00:00.000Z'),
      deliveryIdScanRef: VERIFICATION_ID,
    });
  });

  it('throws NotFoundError without calling Veriff when the driver does not own the order', async () => {
    await expect(
      rig.service.submitResult(DRIVER_USER_ID, ORDER_ID, { verificationId: VERIFICATION_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rig.veriff.getDecisionCalls).toHaveLength(0);
  });

  it('throws ID_SCAN_VERIFICATION_MISMATCH when body.verificationId does not match the row', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: 'different-ref-id' }),
    );

    const promise = rig.service.submitResult(DRIVER_USER_ID, ORDER_ID, {
      verificationId: VERIFICATION_ID,
    });
    await expect(promise).rejects.toBeInstanceOf(ConflictError);
    await expect(promise).rejects.toMatchObject({
      code: 'ID_SCAN_VERIFICATION_MISMATCH',
      statusCode: 409,
    });
    expect(rig.veriff.getDecisionCalls).toHaveLength(0);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('declined decision transitions to id_scan_failed and records failureReason', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );
    rig.veriff.nextDecision = {
      type: 'declined',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      reason: 'face_mismatch',
      code: 9102,
    };

    await rig.service.submitResult(DRIVER_USER_ID, ORDER_ID, {
      verificationId: VERIFICATION_ID,
    });

    expect(rig.ageVerifications.records[0]).toMatchObject({
      passed: false,
      passedAt: null,
      failureReason: 'face_mismatch',
    });
    expect(rig.events.calls[0]!.toStatus).toBe('id_scan_failed');
    expect(rig.events.calls[0]!.eventType).toBe('order_id_scan_failed');
    expect(rig.events.calls[0]!.patch).toEqual({ deliveryIdScanPassed: false });
  });
});

describe('DriverIdScanService.applyWebhookDecision', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('approved webhook: finds via decision.orderId, transitions with actorRole=system and no actorUserId', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.events.calls).toHaveLength(1);
    expect(rig.events.calls[0]!.toStatus).toBe('id_scan_passed');
    expect(rig.events.calls[0]!.actorRole).toBe('system');
    expect(rig.events.calls[0]!.actorUserId).toBeUndefined();
  });

  it('approved webhook + order already in id_scan_passed: records the audit row but skips the transition', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_passed', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    // The idempotent ageVerifications insert still runs (audit trail);
    // but the transition is suppressed.
    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('webhook with verification id mismatching the order is dropped without writes', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: 'different-ref' }),
    );

    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    expect(rig.ageVerifications.records).toHaveLength(0);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('webhook with no matching order is logged + dropped', async () => {
    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    expect(rig.ageVerifications.records).toHaveLength(0);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('pending decision is a no-op (webhooks should not fire on pending, but the guard exists)', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'pending',
      verificationId: VERIFICATION_ID,
    });

    expect(rig.ageVerifications.records).toHaveLength(0);
    expect(rig.events.calls).toHaveLength(0);
  });

  it('resubmission decision records the audit row but does not transition the order', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'resubmission',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      reason: 'blurry_document',
      code: 9103,
    });

    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.ageVerifications.records[0]).toMatchObject({
      passed: false,
      failureReason: 'blurry_document',
    });
    expect(rig.events.calls).toHaveLength(0);
  });

  it('webhook for an already-delivered order is a no-op', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'delivered', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    // The audit row IS recorded for idempotency / completeness.
    expect(rig.ageVerifications.records).toHaveLength(1);
    // But no transition.
    expect(rig.events.calls).toHaveLength(0);
  });

  it('webhook with null decision.orderId falls back to the deliveryIdScanRef lookup', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: null,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
    });

    expect(rig.orders.findByRefCalls).toEqual([VERIFICATION_ID]);
    expect(rig.events.calls).toHaveLength(1);
    expect(rig.events.calls[0]!.toStatus).toBe('id_scan_passed');
  });

  it('declined webhook transitions to id_scan_failed', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'declined',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      reason: 'face_mismatch',
      code: 9102,
    });

    expect(rig.events.calls).toHaveLength(1);
    expect(rig.events.calls[0]!.toStatus).toBe('id_scan_failed');
    expect(rig.events.calls[0]!.actorRole).toBe('system');
    expect(rig.events.calls[0]!.actorUserId).toBeUndefined();
  });
});
