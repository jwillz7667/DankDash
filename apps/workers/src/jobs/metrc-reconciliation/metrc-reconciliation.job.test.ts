/**
 * Metrc reconciliation worker — outcome tests.
 *
 * The job is exercised with hand-rolled fakes for every dep so we cover
 * the full discrepancy taxonomy (clean match / already-reconciled /
 * receipt-id mismatch / missing-upstream past slack / missing-upstream
 * inside slack / unexpected-upstream) without spinning a database or a
 * live Metrc server. Per-dispensary isolation, the credential decrypt
 * path, and the internal `findReceiptCovering` / `groupRowsByDispensary`
 * helpers each get their own block.
 *
 * Fixtures pin two dispensaries (A and B) so we can prove the
 * grouping logic actually splits — a regression that joined every
 * row to every dispensary would still pass any single-dispensary
 * test.
 */
import { type Logger } from '@dankdash/config';
import { type Dispensary, type MetrcTransaction, type Order } from '@dankdash/db';
import { type MetrcReceipt } from '@dankdash/metrc';
import { ExternalServiceError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCREPANCY_AFTER_HOURS,
  DEFAULT_WINDOW_DAYS,
  METRC_WINDOW_SKEW_MS,
  __INTERNALS__,
  runMetrcReconciliationJob,
  type MetrcReconciliationJobDeps,
} from './metrc-reconciliation.job.js';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const DISPENSARY_A_ID = '00000000-0000-7000-8000-0000000000a1';
const DISPENSARY_B_ID = '00000000-0000-7000-8000-0000000000b1';
const ORDER_A1_ID = '00000000-0000-7000-8000-000000000a01';
const ORDER_A2_ID = '00000000-0000-7000-8000-000000000a02';
const ORDER_B1_ID = '00000000-0000-7000-8000-000000000b01';
const ROW_A1_ID = '00000000-0000-7000-8000-000000000010';
const ROW_A2_ID = '00000000-0000-7000-8000-000000000011';
const ROW_B1_ID = '00000000-0000-7000-8000-000000000020';
const LICENSE_A = 'MN-CR-AAAA';
const LICENSE_B = 'MN-CR-BBBB';
const USER_KEY_A = 'usr-key-a';
const USER_KEY_B = 'usr-key-b';
const ENC_BYTES_A = new Uint8Array([0xa, 0xa]);
const ENC_BYTES_B = new Uint8Array([0xb, 0xb]);

function makeOrder(id: string, dispensaryId: string, overrides: Partial<Order> = {}): Order {
  // Only `.id` and `.dispensaryId` are read by the reconciliation job;
  // the rest is type-required filler that keeps the cast honest.
  return {
    id,
    shortCode: `D-${id.slice(-4)}`,
    userId: '00000000-0000-7000-8000-0000000000aa',
    dispensaryId,
    driverId: '00000000-0000-7000-8000-0000000000bb',
    deliveryAddressId: '00000000-0000-7000-8000-0000000000cc',
    status: 'delivered',
    statusChangedAt: new Date('2026-05-18T00:00:00.000Z'),
    subtotalCents: 10_000,
    cannabisTaxCents: 1_000,
    salesTaxCents: 825,
    deliveryFeeCents: 500,
    driverTipCents: 0,
    discountCents: 0,
    totalCents: 12_325,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: new Date('2026-05-18T00:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: new Date('2026-05-18T00:05:00.000Z'),
    rejectedAt: null,
    preppingAt: new Date('2026-05-18T00:10:00.000Z'),
    preparedAt: new Date('2026-05-18T00:25:00.000Z'),
    awaitingDriverAt: new Date('2026-05-18T00:30:00.000Z'),
    dispatchFailedAt: null,
    driverAssignedAt: new Date('2026-05-18T00:35:00.000Z'),
    enRoutePickupAt: new Date('2026-05-18T00:40:00.000Z'),
    pickedUpAt: new Date('2026-05-18T01:00:00.000Z'),
    enRouteDropoffAt: new Date('2026-05-18T01:10:00.000Z'),
    arrivedAtDropoffAt: new Date('2026-05-18T01:40:00.000Z'),
    idScanPendingAt: new Date('2026-05-18T01:45:00.000Z'),
    deliveredAt: new Date('2026-05-18T01:50:00.000Z'),
    returnedToStoreAt: null,
    canceledAt: null,
    canceledBy: null,
    cancelReason: null,
    disputedAt: null,
    deliveryIdScanRef: 'scan_abc',
    deliveryIdScanPassed: true,
    deliveryIdScanAt: new Date('2026-05-18T01:48:00.000Z'),
    customerRating: null,
    customerReview: null,
    dispensaryRating: null,
    driverRating: null,
    ratedAt: null,
    createdAt: new Date('2026-05-18T00:00:00.000Z'),
    updatedAt: new Date('2026-05-18T01:50:01.000Z'),
    ...overrides,
  };
}

function makeDispensary(overrides: Partial<Dispensary> = {}): Dispensary {
  return {
    id: DISPENSARY_A_ID,
    legalName: 'Dispensary A LLC',
    dba: null,
    licenseNumber: LICENSE_A,
    licenseType: 'microbusiness',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    metrcFacilityId: 'MNF-A',
    metrcApiKeyEnc: ENC_BYTES_A,
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

function makeRow(overrides: Partial<MetrcTransaction> = {}): MetrcTransaction {
  return {
    id: ROW_A1_ID,
    orderId: ORDER_A1_ID,
    metrcReceiptId: null,
    packageTags: ['TAG-A1-1'],
    reportedAt: new Date('2026-05-17T00:00:00.000Z'),
    status: 'reported',
    retryCount: 0,
    nextRetryAt: new Date('2026-05-17T00:00:00.000Z'),
    responsePayload: { acceptedAt: '2026-05-17T00:00:00.000Z' },
    failureReason: null,
    createdAt: new Date('2026-05-17T00:00:00.000Z'),
    updatedAt: new Date('2026-05-17T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<MetrcReceipt> = {}): MetrcReceipt {
  return {
    id: 12345,
    receiptNumber: '0000000012345',
    salesDateTime: new Date('2026-05-17T01:50:00.000Z'),
    salesCustomerType: 'Consumer',
    totalPackages: 1,
    totalPrice: '123.25',
    lastModified: new Date('2026-05-17T01:50:05.000Z'),
    transactions: [
      {
        packageId: 9001,
        packageLabel: 'TAG-A1-1',
        productName: 'OG Kush 1g',
        quantity: '1',
        unitOfMeasure: 'Grams',
        totalPrice: '100.00',
      },
    ],
    ...overrides,
  };
}

interface FakeRefs {
  metricTransactions: {
    listReportedSince: ReturnType<typeof vi.fn>;
    markReconciled: ReturnType<typeof vi.fn>;
  };
  orders: { findManyByIds: ReturnType<typeof vi.fn> };
  dispensaries: { listActive: ReturnType<typeof vi.fn> };
  metrc: { listActiveReceipts: ReturnType<typeof vi.fn> };
  encryption: { decryptString: ReturnType<typeof vi.fn> };
  logger: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    child: () => FakeRefs['logger'];
  };
}

function makeLogger(): FakeRefs['logger'] {
  const stub: FakeRefs['logger'] = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => stub,
  };
  return stub;
}

function buildDeps(opts: { logger?: FakeRefs['logger'] } = {}): {
  deps: MetrcReconciliationJobDeps;
  refs: FakeRefs;
} {
  const logger = opts.logger ?? makeLogger();
  const refs: FakeRefs = {
    metricTransactions: {
      listReportedSince: vi.fn().mockResolvedValue([]),
      markReconciled: vi.fn().mockResolvedValue(null),
    },
    orders: { findManyByIds: vi.fn().mockResolvedValue([]) },
    dispensaries: { listActive: vi.fn().mockResolvedValue([]) },
    metrc: { listActiveReceipts: vi.fn().mockResolvedValue([]) },
    encryption: {
      decryptString: vi.fn().mockImplementation((cipher: unknown) => {
        if (cipher === ENC_BYTES_A) return USER_KEY_A;
        if (cipher === ENC_BYTES_B) return USER_KEY_B;
        return 'usr-key-unknown';
      }),
    },
    logger,
  };
  const deps: MetrcReconciliationJobDeps = {
    metricTransactions:
      refs.metricTransactions as unknown as MetrcReconciliationJobDeps['metricTransactions'],
    orders: refs.orders as unknown as MetrcReconciliationJobDeps['orders'],
    dispensaries: refs.dispensaries as unknown as MetrcReconciliationJobDeps['dispensaries'],
    metrc: refs.metrc as unknown as MetrcReconciliationJobDeps['metrc'],
    encryption: refs.encryption as unknown as MetrcReconciliationJobDeps['encryption'],
    logger: logger as unknown as Logger,
  };
  return { deps, refs };
}

describe('runMetrcReconciliationJob — defaults and empty tick', () => {
  it('returns a zero summary when no dispensaries are active', async () => {
    const { deps, refs } = buildDeps();
    const summary = await runMetrcReconciliationJob({ now: NOW, deps });
    expect(summary).toEqual({
      dispensariesProcessed: 0,
      dispensariesSkipped: 0,
      reconciled: 0,
      alreadyReconciled: 0,
      missingUpstream: 0,
      unexpectedUpstream: 0,
      receiptIdMismatches: 0,
      errors: 0,
      discrepancies: [],
    });
    // We still hit the listReportedSince scan even when there are no
    // dispensaries — its window math is the load-bearing invariant.
    expect(refs.metricTransactions.listReportedSince).toHaveBeenCalledTimes(1);
    expect(refs.dispensaries.listActive).toHaveBeenCalledTimes(1);
    expect(refs.metrc.listActiveReceipts).not.toHaveBeenCalled();
  });

  it('passes [now - 7d, now] to listReportedSince by default', async () => {
    const { deps, refs } = buildDeps();
    await runMetrcReconciliationJob({ now: NOW, deps });
    const expectedStart = new Date(NOW.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60_000);
    expect(refs.metricTransactions.listReportedSince).toHaveBeenCalledWith(expectedStart, NOW);
  });

  it('honors a custom windowDays override end-to-end', async () => {
    const { deps, refs } = buildDeps();
    const customDeps: MetrcReconciliationJobDeps = { ...deps, windowDays: 3 };
    await runMetrcReconciliationJob({ now: NOW, deps: customDeps });
    const expectedStart = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000);
    expect(refs.metricTransactions.listReportedSince).toHaveBeenCalledWith(expectedStart, NOW);
  });

  it('rejects non-positive windowDays at the orchestration entry', async () => {
    const { deps } = buildDeps();
    await expect(
      runMetrcReconciliationJob({ now: NOW, deps: { ...deps, windowDays: 0 } }),
    ).rejects.toThrow(RangeError);
    await expect(
      runMetrcReconciliationJob({ now: NOW, deps: { ...deps, windowDays: Number.NaN } }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects negative discrepancyAfterHours at the orchestration entry', async () => {
    const { deps } = buildDeps();
    await expect(
      runMetrcReconciliationJob({ now: NOW, deps: { ...deps, discrepancyAfterHours: -1 } }),
    ).rejects.toThrow(RangeError);
  });
});

describe('runMetrcReconciliationJob — skipped dispensaries', () => {
  it('counts dispensaries with no metrcApiKeyEnc as skipped, never decrypts, never POSTs', async () => {
    const { deps, refs } = buildDeps();
    refs.dispensaries.listActive.mockResolvedValueOnce([
      makeDispensary({ id: DISPENSARY_A_ID, metrcApiKeyEnc: null }),
    ]);
    const summary = await runMetrcReconciliationJob({ now: NOW, deps });
    expect(summary.dispensariesSkipped).toBe(1);
    expect(summary.dispensariesProcessed).toBe(0);
    expect(refs.encryption.decryptString).not.toHaveBeenCalled();
    expect(refs.metrc.listActiveReceipts).not.toHaveBeenCalled();
  });
});

describe('runMetrcReconciliationJob — happy path matches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles a local reported row against the upstream receipt covering its tags', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow();
    const receipt = makeReceipt();
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([receipt]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(refs.encryption.decryptString).toHaveBeenCalledTimes(1);
    expect(refs.metrc.listActiveReceipts).toHaveBeenCalledTimes(1);
    const callArgs = refs.metrc.listActiveReceipts.mock.calls[0]?.[0] as {
      licenseNumber: string;
      userKey: string;
      lastModifiedStart: Date;
      lastModifiedEnd: Date;
    };
    expect(callArgs.licenseNumber).toBe(LICENSE_A);
    expect(callArgs.userKey).toBe(USER_KEY_A);
    // Upstream window is the local window ± METRC_WINDOW_SKEW_MS.
    const expectedLocalStart = new Date(NOW.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60_000);
    expect(callArgs.lastModifiedStart.getTime()).toBe(
      expectedLocalStart.getTime() - METRC_WINDOW_SKEW_MS,
    );
    expect(callArgs.lastModifiedEnd.getTime()).toBe(NOW.getTime() + METRC_WINDOW_SKEW_MS);

    expect(refs.metricTransactions.markReconciled).toHaveBeenCalledWith(ROW_A1_ID, '12345');
    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(summary.alreadyReconciled).toBe(0);
    expect(summary.discrepancies).toHaveLength(0);
  });

  it('covers a local row whose tags are a strict subset of the receipt — receipt may carry extras', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow({ packageTags: ['TAG-A1-1', 'TAG-A1-2'] });
    const receipt = makeReceipt({
      transactions: [
        ...makeReceipt().transactions,
        {
          packageId: 9002,
          packageLabel: 'TAG-A1-2',
          productName: 'OG Kush 1g #2',
          quantity: '1',
          unitOfMeasure: 'Grams',
          totalPrice: '100.00',
        },
        // An extra unrelated tag on the receipt is fine — coverage
        // semantics ask "every local tag in receipt" not "==".
        {
          packageId: 9003,
          packageLabel: 'TAG-UNRELATED',
          productName: 'Other',
          quantity: '1',
          unitOfMeasure: 'Each',
          totalPrice: '5.00',
        },
      ],
    });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([receipt]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(refs.metricTransactions.markReconciled).toHaveBeenCalledTimes(1);
    expect(summary.reconciled).toBe(1);
  });

  it('treats an already-reconciled row with the matching upstream id as a no-op write', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow({ status: 'reconciled', metrcReceiptId: '12345' });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([makeReceipt()]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(refs.metricTransactions.markReconciled).not.toHaveBeenCalled();
    expect(summary.alreadyReconciled).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(summary.discrepancies).toHaveLength(0);
  });
});

describe('runMetrcReconciliationJob — discrepancies', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('flags receipt_id_mismatch when an already-reconciled row points at a different upstream id', async () => {
    const { deps, refs } = buildDeps();
    const row = makeRow({ status: 'reconciled', metrcReceiptId: '99999' });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([makeReceipt({ id: 12345 })]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(refs.metricTransactions.markReconciled).not.toHaveBeenCalled();
    expect(summary.receiptIdMismatches).toBe(1);
    expect(summary.discrepancies).toHaveLength(1);
    expect(summary.discrepancies[0]).toMatchObject({
      kind: 'receipt_id_mismatch',
      dispensaryId: DISPENSARY_A_ID,
      metrcTransactionId: ROW_A1_ID,
      upstreamReceiptId: 12345,
    });
  });

  it('flags missing_upstream when a reported row is older than the slack window with no upstream match', async () => {
    const { deps, refs } = buildDeps();
    const longAgo = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const row = makeRow({ reportedAt: longAgo, packageTags: ['TAG-A1-1'] });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([
      // No upstream tag covers our local tag.
      makeReceipt({
        id: 88888,
        transactions: [
          {
            packageId: 1,
            packageLabel: 'TAG-DIFFERENT',
            productName: 'x',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '0.00',
          },
        ],
      }),
    ]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.missingUpstream).toBe(1);
    // The orphan upstream receipt also flags as unexpected.
    expect(summary.unexpectedUpstream).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(summary.discrepancies).toHaveLength(2);
    const missing = summary.discrepancies.find((d) => d.kind === 'missing_upstream');
    expect(missing?.metrcTransactionId).toBe(ROW_A1_ID);
    expect(missing?.detail).toContain(longAgo.toISOString());
  });

  it('does NOT flag missing_upstream when the reported row is still inside the slack window', async () => {
    const { deps, refs } = buildDeps();
    const recently = new Date(NOW.getTime() - (DEFAULT_DISCREPANCY_AFTER_HOURS - 1) * 60 * 60_000);
    const row = makeRow({ reportedAt: recently });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.missingUpstream).toBe(0);
    expect(summary.discrepancies).toHaveLength(0);
  });

  it('flags unexpected_upstream when Metrc returns a receipt no local row covers', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([
      makeReceipt({ id: 77777, receiptNumber: '0000000077777' }),
    ]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.unexpectedUpstream).toBe(1);
    expect(summary.discrepancies).toHaveLength(1);
    expect(summary.discrepancies[0]).toMatchObject({
      kind: 'unexpected_upstream',
      dispensaryId: DISPENSARY_A_ID,
      upstreamReceiptId: 77777,
      upstreamReceiptNumber: '0000000077777',
    });
  });

  it('a zero-tag local row never covers any receipt — stays flagged as missing_upstream past slack', async () => {
    const { deps, refs } = buildDeps();
    const longAgo = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const row = makeRow({ reportedAt: longAgo, packageTags: [] });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([row]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_A1_ID, DISPENSARY_A_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([makeReceipt()]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(refs.metricTransactions.markReconciled).not.toHaveBeenCalled();
    expect(summary.missingUpstream).toBe(1);
    expect(summary.reconciled).toBe(0);
  });

  it('emits each discrepancy at error-level on the logger so alert pipelines can fire', async () => {
    const logger = makeLogger();
    const { deps, refs } = buildDeps({ logger });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([makeReceipt({ id: 55555 })]);

    await runMetrcReconciliationJob({ now: NOW, deps });

    const errorCalls = logger.error.mock.calls.filter(
      (call) =>
        (call[0] as { event?: string } | undefined)?.event === 'metrc.reconcile.discrepancy',
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.[0]).toMatchObject({ kind: 'unexpected_upstream' });
  });
});

describe('runMetrcReconciliationJob — per-dispensary isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles dispensary B even when dispensary A fails to decrypt', async () => {
    const logger = makeLogger();
    const { deps, refs } = buildDeps({ logger });
    refs.encryption.decryptString.mockImplementation((cipher: unknown) => {
      if (cipher === ENC_BYTES_A) throw new TypeError('aad mismatch');
      if (cipher === ENC_BYTES_B) return USER_KEY_B;
      return 'usr-key-unknown';
    });
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([
      makeRow({ id: ROW_A1_ID, orderId: ORDER_A1_ID, packageTags: ['TAG-A1-1'] }),
      makeRow({ id: ROW_B1_ID, orderId: ORDER_B1_ID, packageTags: ['TAG-B1-1'] }),
    ]);
    refs.orders.findManyByIds.mockResolvedValueOnce([
      makeOrder(ORDER_A1_ID, DISPENSARY_A_ID),
      makeOrder(ORDER_B1_ID, DISPENSARY_B_ID),
    ]);
    refs.dispensaries.listActive.mockResolvedValueOnce([
      makeDispensary(),
      makeDispensary({
        id: DISPENSARY_B_ID,
        licenseNumber: LICENSE_B,
        metrcApiKeyEnc: ENC_BYTES_B,
      }),
    ]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([
      makeReceipt({
        id: 22222,
        transactions: [
          {
            packageId: 5,
            packageLabel: 'TAG-B1-1',
            productName: 'edible',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '10.00',
          },
        ],
      }),
    ]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(refs.metricTransactions.markReconciled).toHaveBeenCalledWith(ROW_B1_ID, '22222');
    const dispErrors = logger.error.mock.calls.filter(
      (call) =>
        (call[0] as { event?: string } | undefined)?.event === 'metrc.reconcile.dispensary_failed',
    );
    expect(dispErrors).toHaveLength(1);
    expect(dispErrors[0]?.[0]).toMatchObject({
      dispensaryId: DISPENSARY_A_ID,
      err: expect.stringContaining('aad mismatch'),
    });
  });

  it('counts a Metrc 5xx as an error and isolates it from the next dispensary', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([
      makeRow({ id: ROW_B1_ID, orderId: ORDER_B1_ID, packageTags: ['TAG-B1-1'] }),
    ]);
    refs.orders.findManyByIds.mockResolvedValueOnce([makeOrder(ORDER_B1_ID, DISPENSARY_B_ID)]);
    refs.dispensaries.listActive.mockResolvedValueOnce([
      makeDispensary(),
      makeDispensary({
        id: DISPENSARY_B_ID,
        licenseNumber: LICENSE_B,
        metrcApiKeyEnc: ENC_BYTES_B,
      }),
    ]);
    refs.metrc.listActiveReceipts
      .mockRejectedValueOnce(
        new ExternalServiceError('metrc', 'Metrc returned status 503', { status: 503 }),
      )
      .mockResolvedValueOnce([
        makeReceipt({
          id: 33333,
          transactions: [
            {
              packageId: 7,
              packageLabel: 'TAG-B1-1',
              productName: 'x',
              quantity: '1',
              unitOfMeasure: 'Each',
              totalPrice: '0.00',
            },
          ],
        }),
      ]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.errors).toBe(1);
    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(refs.metricTransactions.markReconciled).toHaveBeenCalledWith(ROW_B1_ID, '33333');
  });

  it('local rows whose order_id is missing from the orders map are dropped (not crashed on)', async () => {
    const { deps, refs } = buildDeps();
    refs.metricTransactions.listReportedSince.mockResolvedValueOnce([
      makeRow({ id: ROW_A2_ID, orderId: ORDER_A2_ID }),
    ]);
    // findManyByIds returns nothing — the orphan row should be dropped
    // silently rather than blowing up the per-dispensary processor.
    refs.orders.findManyByIds.mockResolvedValueOnce([]);
    refs.dispensaries.listActive.mockResolvedValueOnce([makeDispensary()]);
    refs.metrc.listActiveReceipts.mockResolvedValueOnce([]);

    const summary = await runMetrcReconciliationJob({ now: NOW, deps });

    expect(summary.dispensariesProcessed).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(summary.errors).toBe(0);
  });
});

describe('__INTERNALS__.findReceiptCovering', () => {
  const empty = (): MetrcReceipt => makeReceipt({ id: 1, receiptNumber: '1', transactions: [] });

  it('returns the receipt when every local tag appears in its transactions', () => {
    const found = __INTERNALS__.findReceiptCovering(new Set(['A', 'B']), [
      empty(),
      makeReceipt({
        id: 2,
        receiptNumber: '2',
        transactions: [
          {
            packageId: 1,
            packageLabel: 'A',
            productName: 'x',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '0.00',
          },
          {
            packageId: 2,
            packageLabel: 'B',
            productName: 'x',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '0.00',
          },
          {
            packageId: 3,
            packageLabel: 'C',
            productName: 'x',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '0.00',
          },
        ],
      }),
    ]);
    expect(found?.id).toBe(2);
  });

  it('returns null if any local tag is missing from every receipt', () => {
    const found = __INTERNALS__.findReceiptCovering(new Set(['A', 'B']), [
      makeReceipt({
        id: 9,
        transactions: [
          {
            packageId: 1,
            packageLabel: 'A',
            productName: 'x',
            quantity: '1',
            unitOfMeasure: 'Each',
            totalPrice: '0.00',
          },
        ],
      }),
    ]);
    expect(found).toBeNull();
  });

  it('returns null when the local tag set is empty', () => {
    const found = __INTERNALS__.findReceiptCovering(new Set(), [makeReceipt()]);
    expect(found).toBeNull();
  });

  it('returns the first matching receipt when multiple receipts cover', () => {
    const r1 = makeReceipt({
      id: 100,
      transactions: [
        {
          packageId: 1,
          packageLabel: 'X',
          productName: 'x',
          quantity: '1',
          unitOfMeasure: 'Each',
          totalPrice: '0.00',
        },
      ],
    });
    const r2 = makeReceipt({
      id: 200,
      transactions: [
        {
          packageId: 2,
          packageLabel: 'X',
          productName: 'x',
          quantity: '1',
          unitOfMeasure: 'Each',
          totalPrice: '0.00',
        },
      ],
    });
    const found = __INTERNALS__.findReceiptCovering(new Set(['X']), [r1, r2]);
    expect(found?.id).toBe(100);
  });
});

describe('__INTERNALS__.groupRowsByDispensary', () => {
  it('drops rows whose order is not in the orders map', () => {
    const order = makeOrder(ORDER_A1_ID, DISPENSARY_A_ID);
    const grouped = __INTERNALS__.groupRowsByDispensary(
      [makeRow({ orderId: ORDER_A1_ID }), makeRow({ orderId: ORDER_A2_ID })],
      new Map([[order.id, order]]),
    );
    expect(grouped.size).toBe(1);
    expect(grouped.get(DISPENSARY_A_ID)).toHaveLength(1);
  });

  it('groups multiple rows under their shared dispensary', () => {
    const orderA1 = makeOrder(ORDER_A1_ID, DISPENSARY_A_ID);
    const orderA2 = makeOrder(ORDER_A2_ID, DISPENSARY_A_ID);
    const orderB1 = makeOrder(ORDER_B1_ID, DISPENSARY_B_ID);
    const grouped = __INTERNALS__.groupRowsByDispensary(
      [
        makeRow({ id: ROW_A1_ID, orderId: ORDER_A1_ID }),
        makeRow({ id: ROW_A2_ID, orderId: ORDER_A2_ID }),
        makeRow({ id: ROW_B1_ID, orderId: ORDER_B1_ID }),
      ],
      new Map([
        [orderA1.id, orderA1],
        [orderA2.id, orderA2],
        [orderB1.id, orderB1],
      ]),
    );
    expect(grouped.get(DISPENSARY_A_ID)).toHaveLength(2);
    expect(grouped.get(DISPENSARY_B_ID)).toHaveLength(1);
  });
});

describe('__INTERNALS__.toTagSet', () => {
  it('strips empty strings — defensive against future schema sloppiness', () => {
    const set = __INTERNALS__.toTagSet(['A', '', 'B']);
    expect(set.size).toBe(2);
    expect(set.has('A')).toBe(true);
    expect(set.has('B')).toBe(true);
  });
});

describe('__INTERNALS__.formatDurationHours', () => {
  it('renders to one decimal hour', () => {
    expect(__INTERNALS__.formatDurationHours(90 * 60_000)).toBe('1.5h');
    expect(__INTERNALS__.formatDurationHours(48 * 60 * 60_000)).toBe('48.0h');
    expect(__INTERNALS__.formatDurationHours(0)).toBe('0.0h');
  });
});
