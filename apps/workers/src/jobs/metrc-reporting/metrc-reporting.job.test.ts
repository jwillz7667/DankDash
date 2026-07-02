/**
 * Metrc reporting worker — per-row outcome tests.
 *
 * The job is exercised with hand-rolled fakes for every dep so we can
 * cover the full outcome surface (success / transient retry / terminal
 * failure / data-integrity gaps / per-row crash isolation) without
 * spinning a database. The internal helpers (`buildTransactions`,
 * `classifyError`, `unitOfMeasureFor`) get their own block via
 * `__INTERNALS__` so a future regression in the unit-of-measure mapping
 * or the 4xx-vs-5xx split is caught directly, not just transitively.
 *
 * Fixtures pin a single order and dispensary; tests mutate only what
 * they care about. The product snapshot carries `productType` because
 * that is the only field `buildTransactions` reads from it — the rest
 * is dead weight here even though the real serializer writes more.
 */
import { type Logger } from '@dankdash/config';
import { type Dispensary, type MetrcTransaction, type Order, type OrderItem } from '@dankdash/db';
import { type CreateReceiptInput, type CreateReceiptOutcome } from '@dankdash/metrc';
import { ExternalServiceError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from './backoff.js';
import {
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LEASE_MS,
  __INTERNALS__,
  runMetrcReportingJob,
  type MetrcReportingJobDeps,
} from './metrc-reporting.job.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const DELIVERED_AT = new Date('2026-05-19T11:50:00.000Z');
const ORDER_ID = '00000000-0000-7000-8000-000000000001';
const DISPENSARY_ID = '00000000-0000-7000-8000-000000000002';
const METRC_TXN_ID = '00000000-0000-7000-8000-000000000003';
const LICENSE_NUMBER = 'MN-CR-0042';
const USER_KEY_PLAINTEXT = 'usr-key-decrypted';
const ENC_KEY_BYTES = new Uint8Array([1, 2, 3, 4]);

function makeOrder(overrides: Partial<Order> = {}): Order {
  // The job only reads .status, .deliveredAt, .dispensaryId; the rest
  // are required-by-type filler. Casting through `as unknown` keeps the
  // type surface honest without forcing every CHECK-constraint field to
  // have a meaningful value here.
  return {
    id: ORDER_ID,
    shortCode: 'D-TEST01',
    userId: '00000000-0000-7000-8000-0000000000aa',
    dispensaryId: DISPENSARY_ID,
    driverId: '00000000-0000-7000-8000-0000000000bb',
    deliveryAddressId: '00000000-0000-7000-8000-0000000000cc',
    status: 'delivered',
    statusChangedAt: DELIVERED_AT,
    subtotalCents: 10_000,
    cannabisTaxCents: 1_000,
    salesTaxCents: 825,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 0,
    promoCodeId: null,
    discountFundedBy: null,
    totalCents: 12_325,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: new Date('2026-05-19T10:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: new Date('2026-05-19T10:05:00.000Z'),
    rejectedAt: null,
    preppingAt: new Date('2026-05-19T10:10:00.000Z'),
    preparedAt: new Date('2026-05-19T10:25:00.000Z'),
    awaitingDriverAt: new Date('2026-05-19T10:30:00.000Z'),
    dispatchFailedAt: null,
    driverAssignedAt: new Date('2026-05-19T10:35:00.000Z'),
    enRoutePickupAt: new Date('2026-05-19T10:40:00.000Z'),
    pickedUpAt: new Date('2026-05-19T11:00:00.000Z'),
    enRouteDropoffAt: new Date('2026-05-19T11:10:00.000Z'),
    arrivedAtDropoffAt: new Date('2026-05-19T11:40:00.000Z'),
    idScanPendingAt: new Date('2026-05-19T11:45:00.000Z'),
    deliveredAt: DELIVERED_AT,
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: 'scan_abc',
    deliveryIdScanPassed: true,
    deliveryIdScanAt: new Date('2026-05-19T11:48:00.000Z'),
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: new Date('2026-05-19T10:00:00.000Z'),
    updatedAt: new Date('2026-05-19T11:50:01.000Z'),
    ...overrides,
  };
}

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  // metrcApiKeyEnc is `bytea | null` (`Uint8Array` in JS). Empty Uint8Array
  // would still be "present" — the job only treats `null` as unprovisioned.
  return {
    id: DISPENSARY_ID,
    legalName: 'Test Dispensary LLC',
    dba: null,
    licenseNumber: LICENSE_NUMBER,
    licenseType: 'microbusiness',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: 'MNF-001',
    metrcApiKeyEnc: ENC_KEY_BYTES,
    posProvider: 'manual',
    posCredentialsEnc: null,
    posLastSyncedAt: null,
    addressLine1: '100 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.265, 44.977] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hoursJson: {},
    phone: '+16125550100',
    email: 'ops@example.test',
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    aeropayAccountRef: null,
    isAcceptingOrders: true,
    ratingAvg: null,
    ratingCount: 0,
    status: 'active',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    orderId: ORDER_ID,
    listingId: '00000000-0000-7000-8000-000000000020',
    productSnapshot: { productType: 'flower', name: 'OG Kush 1g' },
    metrcPackageTag: '1A4FF01000000220000123',
    quantity: 1,
    unitPriceCents: 10_000,
    lineSubtotalCents: 10_000,
    thcMgTotal: '180.000',
    cbdMgTotal: '0.000',
    weightGramsTotal: '1.000',
    cannabisTaxCents: 1_000,
    salesTaxCents: 825,
    createdAt: new Date('2026-05-19T10:00:00.000Z'),
    ...overrides,
  };
}

function makeRow(overrides: Partial<MetrcTransaction> = {}): MetrcTransaction {
  return {
    id: METRC_TXN_ID,
    orderId: ORDER_ID,
    metrcReceiptId: null,
    packageTags: ['1A4FF01000000220000123'],
    reportedAt: null,
    status: 'pending',
    retryCount: 0,
    nextRetryAt: new Date('2026-05-19T11:55:00.000Z'),
    responsePayload: null,
    failureReason: null,
    createdAt: new Date('2026-05-19T11:50:01.000Z'),
    updatedAt: new Date('2026-05-19T11:50:01.000Z'),
    ...overrides,
  };
}

function silentLogger(): Logger {
  const noop = (): void => undefined;
  const stub: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  stub['child'] = (): Logger => stub as unknown as Logger;
  return stub as unknown as Logger;
}

interface FakeRefs {
  metricTransactions: {
    claimDueForReporting: ReturnType<typeof vi.fn>;
    markReported: ReturnType<typeof vi.fn>;
    scheduleRetry: ReturnType<typeof vi.fn>;
    markFailedTerminal: ReturnType<typeof vi.fn>;
  };
  orders: { findById: ReturnType<typeof vi.fn> };
  orderItems: { listForOrder: ReturnType<typeof vi.fn> };
  dispensaries: { findById: ReturnType<typeof vi.fn> };
  metrc: { createReceipt: ReturnType<typeof vi.fn> };
  encryption: { decryptString: ReturnType<typeof vi.fn> };
}

function buildDeps(): { deps: MetrcReportingJobDeps; refs: FakeRefs } {
  const refs: FakeRefs = {
    metricTransactions: {
      claimDueForReporting: vi.fn(),
      markReported: vi.fn().mockResolvedValue(null),
      scheduleRetry: vi.fn().mockResolvedValue(null),
      markFailedTerminal: vi.fn().mockResolvedValue(null),
    },
    orders: { findById: vi.fn() },
    orderItems: { listForOrder: vi.fn() },
    dispensaries: { findById: vi.fn() },
    metrc: { createReceipt: vi.fn() },
    encryption: { decryptString: vi.fn().mockReturnValue(USER_KEY_PLAINTEXT) },
  };
  const deps: MetrcReportingJobDeps = {
    metricTransactions:
      refs.metricTransactions as unknown as MetrcReportingJobDeps['metricTransactions'],
    orders: refs.orders as unknown as MetrcReportingJobDeps['orders'],
    orderItems: refs.orderItems as unknown as MetrcReportingJobDeps['orderItems'],
    dispensaries: refs.dispensaries as unknown as MetrcReportingJobDeps['dispensaries'],
    metrc: refs.metrc as unknown as MetrcReportingJobDeps['metrc'],
    encryption: refs.encryption as unknown as MetrcReportingJobDeps['encryption'],
    logger: silentLogger(),
  };
  return { deps, refs };
}

describe('runMetrcReportingJob — defaults and empty tick', () => {
  it('passes DEFAULT_CLAIM_LIMIT + DEFAULT_LEASE_MS to claimDueForReporting when deps omit overrides', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([]);
    const summary = await runMetrcReportingJob({ now: NOW, deps });
    expect(refs.metricTransactions.claimDueForReporting).toHaveBeenCalledWith(
      NOW,
      DEFAULT_CLAIM_LIMIT,
      DEFAULT_LEASE_MS,
    );
    expect(summary).toEqual({
      claimed: 0,
      reported: 0,
      retried: 0,
      failedTerminal: 0,
      errors: 0,
    });
  });

  it('honors per-call claimLimit and leaseMs overrides', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([]);
    const customDeps: MetrcReportingJobDeps = { ...deps, claimLimit: 5, leaseMs: 90_000 };
    await runMetrcReportingJob({ now: NOW, deps: customDeps });
    expect(refs.metricTransactions.claimDueForReporting).toHaveBeenCalledWith(NOW, 5, 90_000);
  });
});

describe('runMetrcReportingJob — happy path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a single delivered order, decrypting the dispensary key and POSTing the receipt', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([row]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([
      makeItem({
        id: '00000000-0000-7000-8000-000000000031',
        productSnapshot: { productType: 'flower' },
        metrcPackageTag: 'TAG-A',
        weightGramsTotal: '1.000',
        lineSubtotalCents: 10_000,
        quantity: 1,
      }),
      makeItem({
        id: '00000000-0000-7000-8000-000000000032',
        productSnapshot: { productType: 'edible' },
        metrcPackageTag: 'TAG-B',
        quantity: 2,
        lineSubtotalCents: 4_000,
      }),
    ]);
    const acceptedAt = new Date('2026-05-19T12:00:01.500Z');
    refs.metrc.createReceipt.mockResolvedValueOnce({ acceptedAt } satisfies CreateReceiptOutcome);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary).toEqual({
      claimed: 1,
      reported: 1,
      retried: 0,
      failedTerminal: 0,
      errors: 0,
    });

    expect(refs.encryption.decryptString).toHaveBeenCalledWith(
      ENC_KEY_BYTES,
      'dispensaries.metrc_api_key_enc',
    );

    expect(refs.metrc.createReceipt).toHaveBeenCalledTimes(1);
    const callArg = refs.metrc.createReceipt.mock.calls[0]?.[0] as CreateReceiptInput;
    expect(callArg.licenseNumber).toBe(LICENSE_NUMBER);
    expect(callArg.userKey).toBe(USER_KEY_PLAINTEXT);
    expect(callArg.salesCustomerType).toBe('Consumer');
    expect(callArg.salesDateTime).toBe(DELIVERED_AT);
    expect(callArg.transactions).toEqual([
      {
        packageLabel: 'TAG-A',
        quantity: '1.000',
        unitOfMeasure: 'Grams',
        totalAmountCents: 10_000,
      },
      {
        packageLabel: 'TAG-B',
        quantity: '2',
        unitOfMeasure: 'Each',
        totalAmountCents: 4_000,
      },
    ]);

    expect(refs.metricTransactions.markReported).toHaveBeenCalledTimes(1);
    expect(refs.metricTransactions.markReported).toHaveBeenCalledWith(METRC_TXN_ID, {
      acceptedAt: acceptedAt.toISOString(),
      transactionCount: 2,
    });
    expect(refs.metricTransactions.scheduleRetry).not.toHaveBeenCalled();
    expect(refs.metricTransactions.markFailedTerminal).not.toHaveBeenCalled();
  });
});

describe('runMetrcReportingJob — data-integrity terminal paths', () => {
  it('terminates when the order row has been deleted', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([row]);
    refs.orders.findById.mockResolvedValueOnce(null);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    expect(refs.metricTransactions.markFailedTerminal).toHaveBeenCalledWith(
      METRC_TXN_ID,
      'order not found',
      undefined,
    );
    expect(refs.metrc.createReceipt).not.toHaveBeenCalled();
  });

  it('terminates when the dispensary row has been deleted', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(null);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    expect(refs.metricTransactions.markFailedTerminal).toHaveBeenCalledWith(
      METRC_TXN_ID,
      'dispensary not found',
      undefined,
    );
  });

  it('terminates when the dispensary has not been provisioned with a Metrc key', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary({ metrcApiKeyEnc: null }));

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    expect(refs.metricTransactions.markFailedTerminal).toHaveBeenCalledWith(
      METRC_TXN_ID,
      'dispensary has no metrc_api_key_enc — not provisioned',
      undefined,
    );
  });

  it('terminates when the order has zero order_items', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([]);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    expect(refs.metricTransactions.markFailedTerminal).toHaveBeenCalledWith(
      METRC_TXN_ID,
      'order has no order_items',
      undefined,
    );
  });

  it('terminates when any item is missing its metrc_package_tag', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([
      makeItem({ id: '00000000-0000-7000-8000-000000000041', metrcPackageTag: null }),
    ]);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('no metrc_package_tag');
  });

  it('terminates when any item snapshot is missing productType', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([
      makeItem({
        id: '00000000-0000-7000-8000-000000000042',
        productSnapshot: { name: 'no type' },
      }),
    ]);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('missing productType');
  });

  it('terminates when key decryption throws (key-rotation desync)', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([makeRow()]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    // `TypeError` extends `Error`, so the production code's `err instanceof Error`
    // narrowing kicks in and surfaces the message; the lint rule that bans
    // `throw new Error(...)` doesn't apply to subclasses.
    refs.encryption.decryptString.mockImplementationOnce(() => {
      throw new TypeError('aad mismatch');
    });

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('aad mismatch');
    expect(refs.metrc.createReceipt).not.toHaveBeenCalled();
  });
});

describe('runMetrcReportingJob — order-status guard rail (defensive retry)', () => {
  it('reschedules when the order status drifted off `delivered` after enqueue (still within budget)', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow({ retryCount: 0 });
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([row]);
    refs.orders.findById.mockResolvedValueOnce(
      makeOrder({ status: 'disputed', deliveredAt: null }),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.retried).toBe(1);
    expect(refs.metricTransactions.scheduleRetry).toHaveBeenCalledTimes(1);
    const [id, nextAt, reason] = refs.metricTransactions.scheduleRetry.mock.calls[0] ?? [];
    expect(id).toBe(METRC_TXN_ID);
    expect((nextAt as Date).toISOString()).toBe('2026-05-19T12:01:00.000Z');
    expect(reason).toContain('order not in delivered state');
  });

  it('terminates when the order is non-delivered AND the retry budget is exhausted', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: MAX_RETRY_ATTEMPTS }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(
      makeOrder({ status: 'canceled', deliveredAt: null }),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('retries exhausted');
  });
});

describe('runMetrcReportingJob — Metrc call failure classification', () => {
  it('reschedules with the 1m delay on a transient 5xx from the upstream', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: 0 }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    const upstream = new ExternalServiceError('metrc', 'metrc 503', { status: 503 });
    refs.metrc.createReceipt.mockRejectedValueOnce(upstream);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.retried).toBe(1);
    expect(refs.metricTransactions.scheduleRetry).toHaveBeenCalledTimes(1);
    const [, nextAt, reason, payload] = refs.metricTransactions.scheduleRetry.mock.calls[0] ?? [];
    expect((nextAt as Date).getTime() - NOW.getTime()).toBe(RETRY_DELAYS_MS[0]);
    expect(reason).toContain('[503]');
    expect(payload).toMatchObject({ status: 503, service: 'metrc' });
  });

  it('reschedules on a 429 Too Many Requests', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: 0 }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    refs.metrc.createReceipt.mockRejectedValueOnce(
      new ExternalServiceError('metrc', 'rate limited', { status: 429 }),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });
    expect(summary.retried).toBe(1);
  });

  it("terminates on a 400 (bad payload — won't self-heal by retry)", async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: 0 }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    refs.metrc.createReceipt.mockRejectedValueOnce(
      new ExternalServiceError('metrc', 'package tag not in license inventory', { status: 400 }),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('[400]');
    expect(reason).toContain('package tag not in license inventory');
    expect(refs.metricTransactions.scheduleRetry).not.toHaveBeenCalled();
  });

  it('terminates on a local validation ExternalServiceError (no status — would never succeed)', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: 0 }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    refs.metrc.createReceipt.mockRejectedValueOnce(
      new ExternalServiceError('metrc', 'salesDateTime is required', {}),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });
    expect(summary.failedTerminal).toBe(1);
  });

  it('treats a bare network error as transient and reschedules', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: 0 }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    refs.metrc.createReceipt.mockRejectedValueOnce(new Error('ECONNRESET'));

    const summary = await runMetrcReportingJob({ now: NOW, deps });
    expect(summary.retried).toBe(1);
    const [, , reason] = refs.metricTransactions.scheduleRetry.mock.calls[0] ?? [];
    expect(reason).toContain('ECONNRESET');
  });

  it('terminates on transient failure after retry budget is exhausted', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([
      makeRow({ retryCount: MAX_RETRY_ATTEMPTS }),
    ]);
    refs.orders.findById.mockResolvedValueOnce(makeOrder());
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem()]);
    refs.metrc.createReceipt.mockRejectedValueOnce(
      new ExternalServiceError('metrc', 'gateway timeout', { status: 504 }),
    );

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary.failedTerminal).toBe(1);
    const [, reason] = refs.metricTransactions.markFailedTerminal.mock.calls[0] ?? [];
    expect(reason).toContain('retry budget exhausted');
    expect(reason).toContain('[504]');
    expect(refs.metricTransactions.scheduleRetry).not.toHaveBeenCalled();
  });
});

describe('runMetrcReportingJob — batch isolation', () => {
  it('processes the next row even if a previous row throws unexpectedly', async () => {
    const { deps, refs } = buildDeps();
    const row1 = makeRow({
      id: '00000000-0000-7000-8000-0000000000a1',
      orderId: '00000000-0000-7000-8000-0000000000b1',
    });
    const row2 = makeRow({
      id: '00000000-0000-7000-8000-0000000000a2',
      orderId: '00000000-0000-7000-8000-0000000000b2',
    });
    refs.metricTransactions.claimDueForReporting.mockResolvedValueOnce([row1, row2]);
    // First findById throws (simulates a transient repo failure mid-batch),
    // second one succeeds with a normal happy path.
    refs.orders.findById
      .mockRejectedValueOnce(new Error('pg client gone'))
      .mockResolvedValueOnce(makeOrder({ id: row2.orderId, dispensaryId: DISPENSARY_ID }));
    refs.dispensaries.findById.mockResolvedValueOnce(makeDispensary());
    refs.orderItems.listForOrder.mockResolvedValueOnce([makeItem({ orderId: row2.orderId })]);
    refs.metrc.createReceipt.mockResolvedValueOnce({
      acceptedAt: new Date('2026-05-19T12:00:02.000Z'),
    } satisfies CreateReceiptOutcome);

    const summary = await runMetrcReportingJob({ now: NOW, deps });

    expect(summary).toEqual({
      claimed: 2,
      reported: 1,
      retried: 0,
      failedTerminal: 0,
      errors: 1,
    });
    expect(refs.metricTransactions.markReported).toHaveBeenCalledTimes(1);
    expect(refs.metricTransactions.markReported.mock.calls[0]?.[0]).toBe(row2.id);
  });
});

describe('__INTERNALS__.unitOfMeasureFor', () => {
  it('maps flower and concentrate to Grams', () => {
    expect(__INTERNALS__.unitOfMeasureFor('flower')).toBe('Grams');
    expect(__INTERNALS__.unitOfMeasureFor('concentrate')).toBe('Grams');
  });

  it('maps everything else to Each (safer default for new types)', () => {
    for (const t of [
      'preroll',
      'infused_preroll',
      'vape',
      'edible',
      'beverage',
      'tincture',
      'topical',
      'accessory',
      'seed',
      'clone',
      'unknown_future_type',
    ]) {
      expect(__INTERNALS__.unitOfMeasureFor(t)).toBe('Each');
    }
  });
});

describe('__INTERNALS__.classifyError', () => {
  it('classifies 5xx and 408/425/429 ExternalServiceErrors as transient', () => {
    for (const status of [500, 502, 503, 504, 408, 425, 429]) {
      const err = new ExternalServiceError('metrc', 'boom', { status });
      expect(__INTERNALS__.classifyError(err)).toBe('transient');
    }
  });

  it('classifies other 4xx ExternalServiceErrors as terminal', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = new ExternalServiceError('metrc', 'boom', { status });
      expect(__INTERNALS__.classifyError(err)).toBe('terminal');
    }
  });

  it('classifies a status-less ExternalServiceError (local validation) as terminal', () => {
    const err = new ExternalServiceError('metrc', 'invalid input', {});
    expect(__INTERNALS__.classifyError(err)).toBe('terminal');
  });

  it('classifies anything that is not an ExternalServiceError (network/DNS) as transient', () => {
    expect(__INTERNALS__.classifyError(new Error('ECONNRESET'))).toBe('transient');
    expect(__INTERNALS__.classifyError('weird non-error')).toBe('transient');
  });
});

describe('__INTERNALS__.buildTransactions', () => {
  it('renders weight-tracked items with weightGramsTotal and unit-tracked items with quantity', () => {
    const result = __INTERNALS__.buildTransactions([
      makeItem({
        id: '00000000-0000-7000-8000-000000000051',
        productSnapshot: { productType: 'flower' },
        metrcPackageTag: 'PT-FLOWER',
        weightGramsTotal: '3.500',
        lineSubtotalCents: 35_000,
        quantity: 1,
      }),
      makeItem({
        id: '00000000-0000-7000-8000-000000000052',
        productSnapshot: { productType: 'beverage' },
        metrcPackageTag: 'PT-BEV',
        weightGramsTotal: '0.000',
        lineSubtotalCents: 1_500,
        quantity: 3,
      }),
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      {
        packageLabel: 'PT-FLOWER',
        quantity: '3.500',
        unitOfMeasure: 'Grams',
        totalAmountCents: 35_000,
      },
      { packageLabel: 'PT-BEV', quantity: '3', unitOfMeasure: 'Each', totalAmountCents: 1_500 },
    ]);
  });

  it('returns an Error (not throws) when a tag is missing', () => {
    const result = __INTERNALS__.buildTransactions([makeItem({ metrcPackageTag: null })]);
    expect(result).toBeInstanceOf(Error);
  });

  it('returns an Error (not throws) when productType cannot be derived', () => {
    const result = __INTERNALS__.buildTransactions([
      makeItem({ productSnapshot: { displayName: 'no productType field' } }),
    ]);
    expect(result).toBeInstanceOf(Error);
  });
});
