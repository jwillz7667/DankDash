/**
 * Unit tests for DriverIdScanService — the Veriff handoff orchestration.
 *
 * Production code under test routes every order-state mutation through
 * OrderTransitionService.transition() (XState event names + actor +
 * patch). Veriff session creation is unconditional once the driver
 * owns the order; subsequent transitions are conditional on the
 * order's current status:
 *
 *   arrived_at_dropoff → DRIVER_ID_SCAN_STARTED → id_scan_pending
 *   id_scan_failed     → DRIVER_ID_SCAN_RETRY   → id_scan_pending
 *   id_scan_pending    → idempotent re-tap (orders.update, no transition)
 *
 * Submit-result and webhook-delivery converge on `applyDecision`, which
 * is purely idempotent at the ageVerifications row (unique on
 * provider+session_id) and short-circuits the transition when the order
 * already reflects the decision.
 */
import { ConflictError, NotFoundError } from '@dankdash/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriverIdScanService, type DriverIdScanScopedRepos } from './driver-id-scan.service.js';
import type {
  OrderTransitionService,
  TransitionRequest,
  TransitionResult,
} from '../../orders/order-transition.service.js';
import type { VeriffClient, VeriffDecision } from '../../identity-verification/veriff.client.js';
import type {
  AgeVerification,
  AgeVerificationsRepository,
  Database,
  NewAgeVerification,
  NewOrder,
  Order,
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
    promoCodeId: null,
    discountFundedBy: null,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: SAMPLE_SNAPSHOT,
    placedAt: new Date('2026-05-15T18:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: new Date('2026-05-15T18:05:00.000Z'),
    rejectedAt: null,
    preppingAt: null,
    preparedAt: new Date('2026-05-15T18:30:00.000Z'),
    awaitingDriverAt: null,
    dispatchFailedAt: null,
    driverAssignedAt: null,
    enRoutePickupAt: null,
    pickedUpAt: new Date('2026-05-15T19:30:00.000Z'),
    enRouteDropoffAt: null,
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
  'findByIdForDriver' | 'findById' | 'findByDeliveryIdScanRef' | 'update'
> {
  public rows = new Map<string, Order>();
  public rowsByRef = new Map<string, Order>();
  public findByIdForDriverCalls: { orderId: string; driverUserId: string }[] = [];
  public findByIdCalls: string[] = [];
  public findByRefCalls: string[] = [];
  public updateCalls: { id: string; patch: Partial<Omit<NewOrder, 'id' | 'createdAt'>> }[] = [];

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

  update(id: string, patch: Partial<Omit<NewOrder, 'id' | 'createdAt'>>): Promise<Order | null> {
    this.updateCalls.push({ id, patch });
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const next: Order = { ...existing, ...patch, updatedAt: new Date() } as Order;
    this.rows.set(id, next);
    if (existing.driverId !== null) this.rows.set(`${id}:${existing.driverId}`, next);
    return Promise.resolve(next);
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
      id: input.id ?? `av_${this.records.length.toString()}`,
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
  public calls: TransitionRequest[] = [];
  public throwError: Error | null = null;

  constructor(private readonly orders: FakeOrdersRepo) {}

  transition = (req: TransitionRequest): Promise<TransitionResult> => {
    this.calls.push(req);
    if (this.throwError !== null) return Promise.reject(this.throwError);

    const driverKey = `${req.orderId}:${DRIVER_USER_ID}`;
    const existing = this.orders.rows.get(driverKey) ?? this.orders.rows.get(req.orderId);
    if (existing === undefined) {
      return Promise.reject(new Error(`fake transition: order ${req.orderId} not seeded`));
    }
    const toStatus = nextStatusForEvent(req.event);
    const next: Order = {
      ...existing,
      status: toStatus,
      statusChangedAt: new Date('2026-05-15T21:00:00.000Z'),
      ...(req.patch as Partial<Order> | undefined),
    } as Order;
    this.orders.rows.set(req.orderId, next);
    if (existing.driverId !== null) this.orders.rows.set(driverKey, next);
    return Promise.resolve({
      orderId: req.orderId,
      fromStatus: existing.status,
      toStatus,
    });
  };
}

function nextStatusForEvent(event: TransitionRequest['event']): Order['status'] {
  switch (event) {
    case 'DRIVER_ID_SCAN_STARTED':
    case 'DRIVER_ID_SCAN_RETRY':
      return 'id_scan_pending';
    case 'ID_SCAN_PASSED':
      return 'id_scan_passed';
    case 'ID_SCAN_FAILED':
      return 'id_scan_failed';
    default:
      throw new Error(`FakeOrderTransitionService: unexpected event ${event}`);
  }
}

interface Rig {
  readonly service: DriverIdScanService;
  readonly orders: FakeOrdersRepo;
  readonly users: FakeUsersRepo;
  readonly ageVerifications: FakeAgeVerificationsRepo;
  readonly veriff: FakeVeriffClient;
  readonly transitions: FakeOrderTransitionService;
}

function makeRig(): Rig {
  const orders = new FakeOrdersRepo();
  const users = new FakeUsersRepo();
  const ageVerifications = new FakeAgeVerificationsRepo();
  const veriff = new FakeVeriffClient();
  const transitions = new FakeOrderTransitionService(orders);
  const scoped: DriverIdScanScopedRepos = {
    orders: orders as unknown as OrdersRepository,
    users: users as unknown as UsersRepository,
    ageVerifications: ageVerifications as unknown as AgeVerificationsRepository,
  };
  const service = new DriverIdScanService(
    FAKE_DB,
    () => scoped,
    veriff as unknown as VeriffClient,
    transitions as unknown as OrderTransitionService,
    { webhookBaseUrl: WEBHOOK_BASE_URL },
  );
  return { service, orders, users, ageVerifications, veriff, transitions };
}

describe('DriverIdScanService.startSession', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('creates a Veriff session, transitions arrived_at_dropoff → id_scan_pending via DRIVER_ID_SCAN_STARTED, returns the session payload', async () => {
    rig.orders.seedForDriver(makeOrder());
    rig.users.seed(makeCustomer());

    const out = await rig.service.startSession(DRIVER_USER_ID, ORDER_ID);

    expect(rig.veriff.createSessionCalls).toHaveLength(1);
    const veriffCall = rig.veriff.createSessionCalls[0]!;
    expect(veriffCall.orderId).toBe(ORDER_ID);
    expect(veriffCall.callback).toBe(`${WEBHOOK_BASE_URL}/v1/webhooks/veriff`);
    expect(veriffCall.person).toEqual({ firstName: 'Sam', lastName: 'Jenkins' });

    expect(rig.transitions.calls).toHaveLength(1);
    const transition = rig.transitions.calls[0]!;
    expect(transition.orderId).toBe(ORDER_ID);
    expect(transition.event).toBe('DRIVER_ID_SCAN_STARTED');
    expect(transition.actor).toEqual({ userId: DRIVER_USER_ID, role: 'driver' });
    expect(transition.payload).toEqual({ verificationId: VERIFICATION_ID });
    expect(transition.patch).toEqual({ deliveryIdScanRef: VERIFICATION_ID });

    expect(out).toEqual({
      verificationId: VERIFICATION_ID,
      sessionUrl: SESSION_URL,
      sessionToken: SESSION_TOKEN,
    });
  });

  it('emits DRIVER_ID_SCAN_RETRY when the order is in id_scan_failed (re-arming after a failed pass)', async () => {
    rig.orders.seedForDriver(makeOrder({ status: 'id_scan_failed' }));
    rig.users.seed(makeCustomer());

    await rig.service.startSession(DRIVER_USER_ID, ORDER_ID);

    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]!.event).toBe('DRIVER_ID_SCAN_RETRY');
    expect(rig.transitions.calls[0]!.patch).toEqual({ deliveryIdScanRef: VERIFICATION_ID });
  });

  it('idempotent re-tap from id_scan_pending: patches deliveryIdScanRef directly with no transition', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_pending', deliveryIdScanRef: 'older-ref' }),
    );
    rig.users.seed(makeCustomer());

    await rig.service.startSession(DRIVER_USER_ID, ORDER_ID);

    // Veriff session creation still happens — the driver gets a fresh token.
    expect(rig.veriff.createSessionCalls).toHaveLength(1);
    // But no transition fires — the order is already in id_scan_pending.
    expect(rig.transitions.calls).toHaveLength(0);
    // Instead, the new verification id is patched onto the row.
    expect(rig.orders.updateCalls).toEqual([
      { id: ORDER_ID, patch: { deliveryIdScanRef: VERIFICATION_ID } },
    ]);
  });

  it('throws NotFoundError without calling Veriff when the driver does not own the order', async () => {
    rig.users.seed(makeCustomer());

    await expect(rig.service.startSession(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.veriff.createSessionCalls).toHaveLength(0);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('throws NotFoundError when the customer row is missing', async () => {
    rig.orders.seedForDriver(makeOrder());
    // No customer seeded.

    await expect(rig.service.startSession(DRIVER_USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(rig.veriff.createSessionCalls).toHaveLength(0);
  });

  it('omits firstName/lastName when the customer has null name fields', async () => {
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

  it('approved happy path: records ageVerifications and transitions to id_scan_passed with the system actor', async () => {
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

    expect(rig.transitions.calls).toHaveLength(1);
    const transition = rig.transitions.calls[0]!;
    expect(transition.event).toBe('ID_SCAN_PASSED');
    // The driver is the relay — the canonical actor is system because the
    // decision is from Veriff, not the driver themselves.
    expect(transition.actor).toEqual({ role: 'system' });
    expect(transition.payload).toMatchObject({
      verificationId: VERIFICATION_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      code: 9001,
      relayActorUserId: DRIVER_USER_ID,
      relayActorRole: 'driver',
    });
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
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]!.event).toBe('ID_SCAN_FAILED');
    expect(rig.transitions.calls[0]!.actor).toEqual({ role: 'system' });
    expect(rig.transitions.calls[0]!.patch).toEqual({ deliveryIdScanPassed: false });
  });
});

describe('DriverIdScanService.applyWebhookDecision', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('approved webhook: finds via decision.orderId, transitions with system actor and no relayActorUserId', async () => {
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
    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]!.event).toBe('ID_SCAN_PASSED');
    expect(rig.transitions.calls[0]!.actor).toEqual({ role: 'system' });
    expect(rig.transitions.calls[0]!.payload).toMatchObject({
      relayActorUserId: null,
      relayActorRole: 'system',
    });
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

    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('declined webhook + order already in id_scan_failed: records the audit row but skips the transition', async () => {
    rig.orders.seedForDriver(
      makeOrder({ status: 'id_scan_failed', deliveryIdScanRef: VERIFICATION_ID }),
    );

    await rig.service.applyWebhookDecision({
      type: 'declined',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T21:00:00.000Z',
      reason: 'face_mismatch',
      code: 9102,
    });

    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(0);
  });

  it('webhook for an already-delivered order records audit but skips transition', async () => {
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

    expect(rig.ageVerifications.records).toHaveLength(1);
    expect(rig.transitions.calls).toHaveLength(0);
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
    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]!.event).toBe('ID_SCAN_PASSED');
  });

  it('declined webhook transitions to id_scan_failed with system actor', async () => {
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

    expect(rig.transitions.calls).toHaveLength(1);
    expect(rig.transitions.calls[0]!.event).toBe('ID_SCAN_FAILED');
    expect(rig.transitions.calls[0]!.actor).toEqual({ role: 'system' });
    expect(rig.transitions.calls[0]!.payload).toMatchObject({
      relayActorUserId: null,
      relayActorRole: 'system',
      reason: 'face_mismatch',
    });
  });
});
