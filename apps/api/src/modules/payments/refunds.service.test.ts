/**
 * RefundsService unit tests with hand-rolled in-memory fakes for the
 * repositories and the Aeropay client surface. Coverage targets every
 * branch the Phase 6 DoD requires (100% on `payments`):
 *
 *   - initiate() ≤ $50 auto-finalizes: refund row created, Aeropay
 *     called once, reverse-ledger entries written, payment status
 *     flipped to refunded / partially_refunded.
 *   - initiate() > $50 leaves the refund pending: no Aeropay call, no
 *     ledger writes.
 *   - initiate() rejects cross-dispensary orders (404), unrefundable
 *     orders (409), and over-refund (422).
 *   - approve() refuses unknown refunds (404), non-pending refunds
 *     (409), same-user approver (422), missing settled tx after
 *     initiation (409), and over-refund after parallel completions
 *     (422).
 *   - approve() happy path goes through finalize the same way the
 *     auto-approve branch does — same ledger shape, same status flip.
 *   - finalize()'s Aeropay failure path marks the refund failed and
 *     surfaces a 502 PaymentError; the refund row's status reflects
 *     the failure so the vendor UI can show it.
 *   - Partial refund flips the tx to partially_refunded; a follow-up
 *     refund that fills the remainder flips it to refunded.
 *
 * Fakes are explicit classes so call shapes are inspectable arrays and
 * the tests can assert ordering between sub-calls (Aeropay before tx,
 * ledger inside tx, etc.).
 */
import { type AeropayPayment, type RefundPaymentInput } from '@dankdash/aeropay';
import {
  type Database,
  type LedgerEntry,
  type NewLedgerEntry,
  type NewRefund,
  type Order,
  type OrdersRepository,
  type PaymentStatus,
  type PaymentTransaction,
  type PaymentTransactionsRepository,
  type Refund,
  type RefundStatus,
  type RefundsRepository,
} from '@dankdash/db';
import { NotFoundError, PaymentError, RepositoryError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import {
  RefundsService,
  type RefundScopedRepos,
  type RefundScopedReposFactory,
} from './refunds.service.js';
import type { AeropayClientLike } from './tokens.js';
import type { VendorContext } from '../listings/vendor/vendor-context.types.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const VENDOR_USER_ID = '01935f3d-0000-7000-8000-000000000002';
const ADMIN_USER_ID = '01935f3d-0000-7000-8000-000000000003';
const ORDER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000a1';
const OTHER_DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000a9';
const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000c1';
const DELIVERY_ADDRESS_ID = '01935f3d-0000-7000-8000-0000000000b1';
const PAYMENT_TX_ID = '01935f3d-0000-7000-8000-0000000000e1';
const AEROPAY_PAYMENT_ID = 'pay_aeropay_abc123';
const AEROPAY_REFUND_ID = 'pay_aeropay_abc123_refund_1';

const VENDOR_CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: VENDOR_USER_ID,
  staffRole: 'manager',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000f0',
};

const ORDER_TOTAL_CENTS = 12_556;

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shortCode: 'DD-ABC123',
    userId: USER_ID,
    dispensaryId: DISPENSARY_ID,
    driverId: DRIVER_ID,
    deliveryAddressId: DELIVERY_ADDRESS_ID,
    status: 'delivered',
    statusChangedAt: new Date('2026-05-01T00:00:00.000Z'),
    subtotalCents: 10_000,
    cannabisTaxCents: 1_000,
    salesTaxCents: 756,
    deliveryFeeCents: 500,
    driverTipCents: 300,
    discountCents: 0,
    totalCents: ORDER_TOTAL_CENTS,
    complianceCheckPayload: {},
    deliveryAddressSnapshot: {},
    placedAt: new Date('2026-05-01T00:00:00.000Z'),
    paymentFailedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    preppingAt: null,
    preparedAt: null,
    awaitingDriverAt: null,
    dispatchFailedAt: null,
    driverAssignedAt: null,
    enRoutePickupAt: null,
    pickedUpAt: null,
    enRouteDropoffAt: null,
    arrivedAtDropoffAt: null,
    idScanPendingAt: null,
    deliveredAt: new Date('2026-05-01T02:00:00.000Z'),
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
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePaymentTransaction(overrides: Partial<PaymentTransaction> = {}): PaymentTransaction {
  return {
    id: PAYMENT_TX_ID,
    orderId: ORDER_ID,
    paymentMethodId: null,
    provider: 'aeropay',
    providerRef: AEROPAY_PAYMENT_ID,
    amountCents: ORDER_TOTAL_CENTS,
    status: 'settled',
    failureCode: null,
    failureReason: null,
    initiatedAt: new Date('2026-05-01T00:00:00.000Z'),
    authorizedAt: new Date('2026-05-01T00:30:00.000Z'),
    settledAt: new Date('2026-05-02T00:00:00.000Z'),
    failedAt: null,
    canceledAt: null,
    rawResponse: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    orderId: ORDER_ID,
    amountCents: 3_000,
    reasonCode: 'missing_item',
    reasonNotes: null,
    initiatedBy: VENDOR_USER_ID,
    approvedBy: null,
    providerRef: null,
    status: 'pending',
    createdAt: new Date('2026-05-03T00:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

class FakeOrdersRepo {
  rows: Order[] = [];
  findByIdCalls: string[] = [];

  findById = (id: string): Promise<Order | null> => {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  };
}

interface UpdateTxStatusCall {
  readonly id: string;
  readonly status: PaymentStatus;
}

class FakePaymentTransactionsRepo {
  rows: PaymentTransaction[] = [];
  listForOrderCalls: string[] = [];
  updateStatusCalls: UpdateTxStatusCall[] = [];

  listForOrder = (orderId: string): Promise<readonly PaymentTransaction[]> => {
    this.listForOrderCalls.push(orderId);
    return Promise.resolve(
      [...this.rows]
        .filter((r) => r.orderId === orderId)
        .sort((a, b) => b.initiatedAt.getTime() - a.initiatedAt.getTime()),
    );
  };

  updateStatus = (id: string, status: PaymentStatus): Promise<PaymentTransaction | null> => {
    this.updateStatusCalls.push({ id, status });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    row.updatedAt = new Date('2026-05-03T13:00:00.000Z');
    return Promise.resolve(row);
  };
}

interface UpdateRefundStatusCall {
  readonly id: string;
  readonly status: RefundStatus;
  readonly patch: Partial<Pick<NewRefund, 'providerRef' | 'completedAt'>>;
}

interface ApproveCall {
  readonly id: string;
  readonly approverUserId: string;
}

class FakeRefundsRepo {
  rows: Refund[] = [];
  createCalls: Array<Omit<NewRefund, 'id'>> = [];
  updateStatusCalls: UpdateRefundStatusCall[] = [];
  approveCalls: ApproveCall[] = [];
  approveReturnsNullFor: string | null = null;
  private idSeq = 1;

  findById = (id: string): Promise<Refund | null> =>
    Promise.resolve(this.rows.find((r) => r.id === id) ?? null);

  totalRefundedCents = (orderId: string): Promise<number> =>
    Promise.resolve(
      this.rows
        .filter((r) => r.orderId === orderId && r.status === 'completed')
        .reduce((sum, r) => sum + r.amountCents, 0),
    );

  create = (input: Omit<NewRefund, 'id'> & { readonly id?: string }): Promise<Refund> => {
    const row: Refund = makeRefund({
      id: input.id ?? `01935f3d-0000-7000-8000-${String(0xf100 + this.idSeq++).padStart(12, '0')}`,
      orderId: input.orderId,
      amountCents: input.amountCents,
      reasonCode: input.reasonCode,
      reasonNotes: input.reasonNotes ?? null,
      initiatedBy: input.initiatedBy,
      approvedBy: input.approvedBy ?? null,
      providerRef: input.providerRef ?? null,
      status: input.status ?? 'pending',
      createdAt: new Date('2026-05-03T00:00:00.000Z'),
      completedAt: null,
    });
    this.createCalls.push({ ...input, reasonNotes: input.reasonNotes ?? null });
    this.rows.push(row);
    return Promise.resolve(row);
  };

  approve = (id: string, approverUserId: string): Promise<Refund | null> => {
    this.approveCalls.push({ id, approverUserId });
    if (this.approveReturnsNullFor === id) return Promise.resolve(null);
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    if (row.initiatedBy === approverUserId) {
      throw new RangeError(
        `refunds.approve: approver ${approverUserId} cannot also be initiator (separation of duties)`,
      );
    }
    row.approvedBy = approverUserId;
    return Promise.resolve(row);
  };

  updateStatus = (
    id: string,
    status: RefundStatus,
    patch: Partial<Pick<NewRefund, 'providerRef' | 'completedAt'>> = {},
  ): Promise<Refund | null> => {
    this.updateStatusCalls.push({ id, status, patch });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    if (patch.providerRef !== undefined) row.providerRef = patch.providerRef;
    if (patch.completedAt !== undefined) row.completedAt = patch.completedAt;
    return Promise.resolve(row);
  };
}

type LedgerEntryInput = Omit<NewLedgerEntry, 'id'> & { readonly id?: string };

class FakeLedgerEntriesRepo {
  rows: LedgerEntry[] = [];
  recordTransactionCalls: Array<readonly LedgerEntryInput[]> = [];
  private idSeq = 1;

  recordTransaction = (entries: readonly LedgerEntryInput[]): Promise<readonly LedgerEntry[]> => {
    this.recordTransactionCalls.push(entries);
    if (entries.length === 0) {
      throw new RangeError('recordTransaction: at least one entry required');
    }
    let debit = 0;
    let credit = 0;
    for (const e of entries) {
      debit += e.debitCents ?? 0;
      credit += e.creditCents ?? 0;
    }
    if (debit !== credit) {
      throw new RangeError(
        `recordTransaction: unbalanced ledger — debits=${String(debit)} credits=${String(credit)}`,
      );
    }
    const now = new Date('2026-05-03T13:00:00.000Z');
    const materialized: LedgerEntry[] = entries.map((e) => ({
      id: e.id ?? `01935f3d-0000-7000-8000-${String(0x5000 + this.idSeq++).padStart(12, '0')}`,
      orderId: e.orderId ?? null,
      payoutId: e.payoutId ?? null,
      refundId: e.refundId ?? null,
      accountType: e.accountType,
      accountRef: e.accountRef ?? null,
      debitCents: e.debitCents ?? 0,
      creditCents: e.creditCents ?? 0,
      description: e.description,
      occurredAt: e.occurredAt ?? now,
      createdAt: now,
    }));
    this.rows.push(...materialized);
    return Promise.resolve(materialized);
  };
}

class FakeAeropayClient implements AeropayClientLike {
  refundCalls: RefundPaymentInput[] = [];
  nextRefundResponse: AeropayPayment = {
    id: AEROPAY_REFUND_ID,
    status: 'refunded',
    amountCents: 3_000,
    bankAccountId: 'ba_real_account_123',
    customerRef: USER_ID,
    orderRef: ORDER_ID,
    createdAt: new Date('2026-05-03T12:00:00.000Z'),
  };
  shouldThrow: Error | null = null;

  refundPayment = (input: RefundPaymentInput): Promise<AeropayPayment> => {
    this.refundCalls.push(input);
    if (this.shouldThrow !== null) return Promise.reject(this.shouldThrow);
    return Promise.resolve({ ...this.nextRefundResponse, amountCents: input.amountCents });
  };

  // The surfaces RefundsService doesn't call. Defined so AeropayClientLike
  // conformance fails the compile if the interface widens.
  linkBankAccount = (): Promise<never> => Promise.reject(new Error('not used'));
  getBankAccount = (): Promise<never> => Promise.reject(new Error('not used'));
  createPayment = (): Promise<never> => Promise.reject(new Error('not used'));
  getPayment = (): Promise<never> => Promise.reject(new Error('not used'));
  cancelPayment = (): Promise<never> => Promise.reject(new Error('not used'));
  createPayout = (): Promise<never> => Promise.reject(new Error('not used'));
}

function build(): {
  service: RefundsService;
  ordersRepo: FakeOrdersRepo;
  txRepo: FakePaymentTransactionsRepo;
  refundsRepo: FakeRefundsRepo;
  ledgerRepo: FakeLedgerEntriesRepo;
  aeropay: FakeAeropayClient;
} {
  const ordersRepo = new FakeOrdersRepo();
  const txRepo = new FakePaymentTransactionsRepo();
  const refundsRepo = new FakeRefundsRepo();
  const ledgerRepo = new FakeLedgerEntriesRepo();
  const aeropay = new FakeAeropayClient();
  const fakeDb = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Database;
  const refundReposFor: RefundScopedReposFactory = () =>
    ({
      refunds: refundsRepo,
      paymentTransactions: txRepo,
      ledgerEntries: ledgerRepo,
    }) as unknown as RefundScopedRepos;
  const service = new RefundsService(
    ordersRepo as unknown as OrdersRepository,
    txRepo as unknown as PaymentTransactionsRepository,
    refundsRepo as unknown as RefundsRepository,
    fakeDb,
    refundReposFor,
    aeropay,
  );
  return { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay };
}

describe('RefundsService.initiate', () => {
  it('auto-finalizes a refund at or below the $50 cap', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());

    const res = await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 5_000,
      reasonCode: 'missing_item',
      reasonNotes: 'Customer reported one item missing',
    });

    expect(aeropay.refundCalls).toHaveLength(1);
    expect(aeropay.refundCalls[0]).toMatchObject({
      paymentId: AEROPAY_PAYMENT_ID,
      amountCents: 5_000,
      reasonCode: 'missing_item',
    });
    expect(aeropay.refundCalls[0]?.idempotencyKey.startsWith('refund:')).toBe(true);

    expect(refundsRepo.rows).toHaveLength(1);
    expect(refundsRepo.rows[0]?.status).toBe('completed');
    expect(refundsRepo.rows[0]?.providerRef).toBe(AEROPAY_REFUND_ID);
    expect(refundsRepo.rows[0]?.completedAt).not.toBeNull();
    expect(refundsRepo.rows[0]?.approvedBy).toBeNull();
    expect(refundsRepo.rows[0]?.initiatedBy).toBe(VENDOR_USER_ID);
    expect(refundsRepo.rows[0]?.reasonNotes).toBe('Customer reported one item missing');

    expect(ledgerRepo.recordTransactionCalls).toHaveLength(1);
    const entries = ledgerRepo.recordTransactionCalls[0] ?? [];
    expect(entries).toHaveLength(2);
    const reserve = entries.find((e) => e.accountType === 'refund_reserve');
    const customer = entries.find((e) => e.accountType === 'customer');
    expect(reserve?.debitCents).toBe(5_000);
    expect(reserve?.creditCents).toBe(0);
    expect(reserve?.accountRef).toBe(DISPENSARY_ID);
    expect(reserve?.refundId).toBe(refundsRepo.rows[0]?.id);
    expect(customer?.debitCents).toBe(0);
    expect(customer?.creditCents).toBe(5_000);
    expect(customer?.accountRef).toBe(USER_ID);
    expect(customer?.refundId).toBe(refundsRepo.rows[0]?.id);

    expect(txRepo.updateStatusCalls).toEqual([{ id: PAYMENT_TX_ID, status: 'partially_refunded' }]);

    expect(res.status).toBe('completed');
    expect(res.requiresAdminApproval).toBe(false);
    expect(res.providerRef).toBe(AEROPAY_REFUND_ID);
    expect(res.completedAt).not.toBeNull();
  });

  it('throws RepositoryError when the refund row vanishes inside the finalize tx', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    // Aeropay has already moved the money; the in-tx status flip then finds
    // the refund row gone. Throwing rolls back the payment-status flip and the
    // ledger insert so the tx leaves no half-written state.
    refundsRepo.updateStatus = (): Promise<Refund | null> => Promise.resolve(null);

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 5_000,
        reasonCode: 'missing_item',
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(0);
  });

  it('throws RepositoryError when the payment row vanishes inside the finalize tx', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    // The refund row flips fine, but the payment_transactions status UPDATE
    // returns null — the same roll-back guarantee must hold for the second
    // write in the tx.
    txRepo.updateStatus = (): Promise<PaymentTransaction | null> => Promise.resolve(null);

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 5_000,
        reasonCode: 'missing_item',
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
    expect(refundsRepo.rows[0]?.status).toBe('completed');
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(0);
  });

  it('flips payment status to refunded when the refund clears the full charge', async () => {
    const { service, ordersRepo, txRepo, refundsRepo } = build();
    ordersRepo.rows.push(makeOrder({ subtotalCents: 5_000, totalCents: 5_000 }));
    txRepo.rows.push(makePaymentTransaction({ amountCents: 5_000 }));

    await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 5_000,
      reasonCode: 'order_canceled',
    });

    expect(refundsRepo.rows[0]?.status).toBe('completed');
    expect(txRepo.updateStatusCalls).toEqual([{ id: PAYMENT_TX_ID, status: 'refunded' }]);
  });

  it('leaves the refund pending when amount exceeds the $50 cap', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());

    const res = await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 5_001,
      reasonCode: 'damaged_product',
    });

    expect(aeropay.refundCalls).toHaveLength(0);
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(0);
    expect(txRepo.updateStatusCalls).toHaveLength(0);

    expect(refundsRepo.rows).toHaveLength(1);
    expect(refundsRepo.rows[0]?.status).toBe('pending');
    expect(refundsRepo.rows[0]?.providerRef).toBeNull();
    expect(refundsRepo.rows[0]?.completedAt).toBeNull();
    expect(refundsRepo.rows[0]?.approvedBy).toBeNull();

    expect(res.status).toBe('pending');
    expect(res.requiresAdminApproval).toBe(true);
    expect(res.providerRef).toBeNull();
    expect(res.completedAt).toBeNull();
  });

  it('returns 404 for an order in another dispensary', async () => {
    const { service, ordersRepo, refundsRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder({ dispensaryId: OTHER_DISPENSARY_ID }));

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 2_500,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(refundsRepo.rows).toHaveLength(0);
    expect(aeropay.refundCalls).toHaveLength(0);
  });

  it('returns 404 for a non-existent order', async () => {
    const { service } = build();
    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 2_500,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects when the order has no settled payment', async () => {
    const { service, ordersRepo, txRepo, refundsRepo } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction({ status: 'authorized' }));

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 2_500,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toMatchObject({ code: 'NO_REFUNDABLE_PAYMENT' });
    expect(refundsRepo.rows).toHaveLength(0);
  });

  it('allows a refund against a partially_refunded payment', async () => {
    const { service, ordersRepo, txRepo, refundsRepo } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction({ status: 'partially_refunded' }));
    // One $4_000 refund already completed earlier.
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fa',
        amountCents: 4_000,
        status: 'completed',
        providerRef: 'prior_refund_ref',
        completedAt: new Date('2026-05-03T05:00:00.000Z'),
      }),
    );

    await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 2_500,
      reasonCode: 'order_canceled',
    });

    expect(refundsRepo.rows).toHaveLength(2);
    const newRefund = refundsRepo.rows[1];
    expect(newRefund?.status).toBe('completed');
    expect(newRefund?.amountCents).toBe(2_500);
    expect(txRepo.updateStatusCalls).toEqual([{ id: PAYMENT_TX_ID, status: 'partially_refunded' }]);
  });

  it('rejects when the cumulative refund would exceed the original charge', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    // 10_000 already completed; only 2_556 of headroom remains against
    // the 12_556 total. Asking for another 3_000 must fail.
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fb',
        amountCents: 10_000,
        status: 'completed',
        providerRef: 'prior_refund_ref',
        completedAt: new Date('2026-05-03T05:00:00.000Z'),
      }),
    );

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 3_000,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(aeropay.refundCalls).toHaveLength(0);
    expect(refundsRepo.rows).toHaveLength(1); // only the pre-existing one
  });

  it('marks the refund failed and throws 502 when Aeropay refundPayment rejects', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    aeropay.shouldThrow = new Error('aeropay outage');

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 2_500,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toBeInstanceOf(PaymentError);

    expect(refundsRepo.rows).toHaveLength(1);
    expect(refundsRepo.rows[0]?.status).toBe('failed');
    expect(refundsRepo.rows[0]?.providerRef).toBeNull();
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(0);
    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('throws RepositoryError when the fail-marking UPDATE also returns null after an Aeropay outage', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    aeropay.shouldThrow = new Error('aeropay outage');
    // Aeropay fails, then the compensating "mark failed" write also reports the
    // row gone. The original cause must be chained onto the repo error rather
    // than masked by the 502.
    refundsRepo.updateStatus = (): Promise<Refund | null> => Promise.resolve(null);

    await expect(
      service.initiate(VENDOR_CTX, ORDER_ID, {
        amountCents: 2_500,
        reasonCode: 'damaged_product',
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(0);
  });
});

describe('RefundsService.approve', () => {
  it('finalizes a pending refund when the admin is different from the initiator', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        amountCents: 8_000,
        status: 'pending',
        initiatedBy: VENDOR_USER_ID,
      }),
    );

    const res = await service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc');

    expect(refundsRepo.approveCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-0000000000fc', approverUserId: ADMIN_USER_ID },
    ]);
    expect(aeropay.refundCalls).toHaveLength(1);
    expect(aeropay.refundCalls[0]?.amountCents).toBe(8_000);
    expect(refundsRepo.rows[0]?.status).toBe('completed');
    expect(refundsRepo.rows[0]?.approvedBy).toBe(ADMIN_USER_ID);
    expect(refundsRepo.rows[0]?.providerRef).toBe(AEROPAY_REFUND_ID);

    expect(ledgerRepo.recordTransactionCalls).toHaveLength(1);
    expect(ledgerRepo.recordTransactionCalls[0]?.[0]?.accountType).toBe('refund_reserve');
    expect(ledgerRepo.recordTransactionCalls[0]?.[1]?.accountType).toBe('customer');

    expect(txRepo.updateStatusCalls).toEqual([{ id: PAYMENT_TX_ID, status: 'partially_refunded' }]);

    expect(res.requiresAdminApproval).toBe(true);
    expect(res.approvedBy).toBe(ADMIN_USER_ID);
  });

  it('throws RepositoryError when the order backing a pending refund has vanished', async () => {
    const { service, refundsRepo, aeropay } = build();
    // Pending refund exists but its order row is gone — the FK should have
    // prevented this, so approve() fails loudly instead of refunding blind.
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fd',
        amountCents: 4_000,
        status: 'pending',
        initiatedBy: VENDOR_USER_ID,
      }),
    );

    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fd'),
    ).rejects.toBeInstanceOf(RepositoryError);
    expect(aeropay.refundCalls).toHaveLength(0);
  });

  it('returns 404 for an unknown refund id', async () => {
    const { service } = build();
    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a refund already completed', async () => {
    const { service, refundsRepo } = build();
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        status: 'completed',
        providerRef: 'prior',
        completedAt: new Date('2026-05-03T05:00:00.000Z'),
      }),
    );
    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_PENDING' });
  });

  it('rejects when the approver equals the initiator (separation of duties)', async () => {
    const { service, refundsRepo, aeropay } = build();
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        status: 'pending',
        initiatedBy: ADMIN_USER_ID,
      }),
    );
    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(refundsRepo.approveCalls).toHaveLength(0);
    expect(aeropay.refundCalls).toHaveLength(0);
  });

  it('returns 409 when no refundable payment remains on the order', async () => {
    const { service, ordersRepo, txRepo, refundsRepo } = build();
    ordersRepo.rows.push(makeOrder());
    // Payment was canceled between the vendor initiating and the admin
    // approving — refund cannot proceed.
    txRepo.rows.push(makePaymentTransaction({ status: 'canceled' }));
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        amountCents: 8_000,
        status: 'pending',
        initiatedBy: VENDOR_USER_ID,
      }),
    );

    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toMatchObject({ code: 'NO_REFUNDABLE_PAYMENT' });
  });

  it('rejects when a parallel refund consumed the remaining budget', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    // Pending refund for 8_000 + already-completed 6_000 > 12_556 total.
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        amountCents: 8_000,
        status: 'pending',
        initiatedBy: VENDOR_USER_ID,
      }),
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fd',
        amountCents: 6_000,
        status: 'completed',
        providerRef: 'prior',
        completedAt: new Date('2026-05-03T05:00:00.000Z'),
      }),
    );

    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(aeropay.refundCalls).toHaveLength(0);
  });

  it('returns 404 when refunds.approve returns null (row vanished mid-flight)', async () => {
    const { service, ordersRepo, txRepo, refundsRepo } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());
    refundsRepo.rows.push(
      makeRefund({
        id: '01935f3d-0000-7000-8000-0000000000fc',
        amountCents: 8_000,
        status: 'pending',
        initiatedBy: VENDOR_USER_ID,
      }),
    );
    refundsRepo.approveReturnsNullFor = '01935f3d-0000-7000-8000-0000000000fc';

    await expect(
      service.approve(ADMIN_USER_ID, '01935f3d-0000-7000-8000-0000000000fc'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('RefundsService end-to-end partial → full refund', () => {
  it('flips payment status to refunded once the cumulative refund matches the charge', async () => {
    const { service, ordersRepo, txRepo, refundsRepo, ledgerRepo, aeropay } = build();
    ordersRepo.rows.push(makeOrder());
    txRepo.rows.push(makePaymentTransaction());

    // First small refund auto-finalizes.
    await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 5_000,
      reasonCode: 'missing_item',
    });
    expect(refundsRepo.rows[0]?.status).toBe('completed');
    expect(txRepo.rows[0]?.status).toBe('partially_refunded');

    // Second refund of the exact remainder (12_556 - 5_000 = 7_556) is
    // above the cap so needs admin approval, then flips status to
    // refunded.
    await service.initiate(VENDOR_CTX, ORDER_ID, {
      amountCents: 7_556,
      reasonCode: 'damaged_product',
    });
    expect(refundsRepo.rows[1]?.status).toBe('pending');

    await service.approve(ADMIN_USER_ID, refundsRepo.rows[1]?.id ?? '');
    expect(refundsRepo.rows[1]?.status).toBe('completed');
    expect(txRepo.rows[0]?.status).toBe('refunded');
    expect(aeropay.refundCalls).toHaveLength(2);
    expect(ledgerRepo.recordTransactionCalls).toHaveLength(2);
  });
});
