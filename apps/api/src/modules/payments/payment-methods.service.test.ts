/**
 * PaymentMethodsService unit tests with hand-rolled in-memory fakes for
 * the repository and the Aeropay client surface. Coverage targets every
 * branch the Phase 6 DoD requires (100% on `payments` module):
 *
 *   - list() projects PaymentMethod rows into the response shape.
 *   - linkAeropay() creates a pending row, returns the hosted URL, and
 *     enforces the "one in-flight session per user" conflict.
 *   - delete() refuses cross-user access (NotFoundError), refuses
 *     already-deleted rows, and calls softDelete on the happy path.
 *   - applyWebhook() handles bank_account.linked / bank_account.failed,
 *     payment.authorized / settled / failed / canceled, ignores unrelated
 *     events, handles missing rows gracefully, dedupes replays, and
 *     surfaces the missing-row PaymentError when a bank UPDATE returns
 *     null mid-flight.
 *
 * Fakes are explicit classes (not `vi.fn()`) so the call shapes are
 * inspectable as plain arrays — easier to assert on than mock records.
 */
import {
  type AeropayBankAccount,
  type AeropayLinkSession,
  type AeropayWebhookOutcome,
} from '@dankdash/aeropay';
import {
  type NewPaymentMethod,
  type NewPaymentTransaction,
  type Order,
  type OrdersRepository,
  type OrderStatusTransitionInput,
  type PaymentMethod,
  type PaymentMethodsRepository,
  type PaymentStatus,
  type PaymentTransaction,
  type PaymentTransactionsRepository,
} from '@dankdash/db';
import { ConflictError, NotFoundError, PaymentError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { PaymentMethodsService } from './payment-methods.service.js';
import type { AeropayClientLike } from './tokens.js';

type UpsertPatch = Pick<PaymentMethod, 'aeropayPaymentMethodRef' | 'bankName' | 'last4' | 'status'>;
type TxStatusPatch = Partial<
  Pick<
    NewPaymentTransaction,
    | 'authorizedAt'
    | 'settledAt'
    | 'failedAt'
    | 'canceledAt'
    | 'failureCode'
    | 'failureReason'
    | 'rawResponse'
  >
>;

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01935f3d-0000-7000-8000-000000000002';
const ORDER_ID = '01935f3d-0000-7000-8000-0000000000d1';
const PAYMENT_TX_ID = '01935f3d-0000-7000-8000-0000000000e1';
const AEROPAY_PAYMENT_ID = 'pay_aeropay_abc123';
const WEBHOOK_OCCURRED_AT = new Date('2026-05-02T12:00:00.000Z');

function makeMethod(overrides: Partial<PaymentMethod> = {}): PaymentMethod {
  return {
    id: '01935f3d-0000-7000-8000-000000000aaa',
    userId: USER_ID,
    type: 'aeropay_ach',
    aeropayPaymentMethodRef: 'ba_test_123',
    bankName: 'Test Bank',
    last4: '1234',
    isDefault: false,
    status: 'active',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    deletedAt: null,
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
    amountCents: 4000,
    status: 'initiated',
    failureCode: null,
    failureReason: null,
    initiatedAt: new Date('2026-05-01T00:00:00.000Z'),
    authorizedAt: null,
    settledAt: null,
    failedAt: null,
    canceledAt: null,
    rawResponse: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface UpsertCall {
  readonly id: string;
  readonly patch: UpsertPatch;
}

class FakePaymentMethodsRepo {
  rows: PaymentMethod[] = [];
  softDeleteCalls: string[] = [];
  updateStatusCalls: Array<{ id: string; status: PaymentMethod['status'] }> = [];
  updateBankAccountDetailsCalls: UpsertCall[] = [];
  returnNullOnUpdate = false;

  findById = (id: string): Promise<PaymentMethod | null> =>
    Promise.resolve(this.rows.find((r) => r.id === id) ?? null);

  listForUser = (userId: string): Promise<readonly PaymentMethod[]> =>
    Promise.resolve(
      [...this.rows]
        .filter((r) => r.userId === userId && r.deletedAt === null)
        .sort((a, b) => {
          if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        }),
    );

  findByAeropayRef = (ref: string): Promise<PaymentMethod | null> =>
    Promise.resolve(this.rows.find((r) => r.aeropayPaymentMethodRef === ref) ?? null);

  create = (
    input: Omit<NewPaymentMethod, 'id'> & { readonly id?: string },
  ): Promise<PaymentMethod> => {
    const row: PaymentMethod = makeMethod({
      id: input.id ?? `01935f3d-0000-7000-8000-${String(this.rows.length).padStart(12, '0')}`,
      userId: input.userId,
      type: input.type,
      aeropayPaymentMethodRef: input.aeropayPaymentMethodRef ?? null,
      bankName: input.bankName ?? null,
      last4: input.last4 ?? null,
      isDefault: input.isDefault ?? false,
      status: input.status ?? 'pending',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
      deletedAt: null,
    });
    this.rows.push(row);
    return Promise.resolve(row);
  };

  softDelete = (id: string): Promise<void> => {
    this.softDeleteCalls.push(id);
    const row = this.rows.find((r) => r.id === id);
    if (row !== undefined) {
      row.deletedAt = new Date('2026-05-01T01:00:00.000Z');
      row.isDefault = false;
    }
    return Promise.resolve();
  };

  updateStatus = (id: string, status: PaymentMethod['status']): Promise<PaymentMethod | null> => {
    this.updateStatusCalls.push({ id, status });
    if (this.returnNullOnUpdate) return Promise.resolve(null);
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    row.updatedAt = new Date('2026-05-01T02:00:00.000Z');
    return Promise.resolve(row);
  };

  updateBankAccountDetails = (
    id: string,
    patch: UpsertCall['patch'],
  ): Promise<PaymentMethod | null> => {
    this.updateBankAccountDetailsCalls.push({ id, patch });
    if (this.returnNullOnUpdate) return Promise.resolve(null);
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.aeropayPaymentMethodRef = patch.aeropayPaymentMethodRef ?? null;
    row.bankName = patch.bankName ?? null;
    row.last4 = patch.last4 ?? null;
    row.status = patch.status;
    row.updatedAt = new Date('2026-05-01T02:00:00.000Z');
    return Promise.resolve(row);
  };
}

class FakeAeropayClient implements AeropayClientLike {
  linkCalls: Array<{ customerRef: string; returnUrl: string }> = [];
  getBankAccountCalls: string[] = [];
  nextLinkSession: AeropayLinkSession = {
    id: 'link_session_test_1',
    hostedUrl: 'https://link.aeropay.com/session/test_1',
    expiresAt: new Date('2026-05-01T03:00:00.000Z'),
  };
  bankAccountsById = new Map<string, AeropayBankAccount>();

  linkBankAccount = (input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<AeropayLinkSession> => {
    this.linkCalls.push(input);
    return Promise.resolve(this.nextLinkSession);
  };

  getBankAccount = (id: string): Promise<AeropayBankAccount> => {
    this.getBankAccountCalls.push(id);
    const account = this.bankAccountsById.get(id);
    if (account === undefined) {
      return Promise.reject(new Error(`unexpected getBankAccount: ${id}`));
    }
    return Promise.resolve(account);
  };

  // Stubs for the surface PaymentMethodsService doesn't drive directly —
  // checkout owns createPayment, the refunds/payouts services own the
  // rest. Presence forces AeropayClientLike conformance at compile time
  // so a future interface change does not silently bypass these tests.
  createPayment = (): Promise<never> => Promise.reject(new Error('not used in payment-methods'));
  getPayment = (): Promise<never> => Promise.reject(new Error('not used in payment-methods'));
  cancelPayment = (): Promise<never> => Promise.reject(new Error('not used in payment-methods'));
  refundPayment = (): Promise<never> => Promise.reject(new Error('not used in payment-methods'));
  createPayout = (): Promise<never> => Promise.reject(new Error('not used in payment-methods'));
}

interface UpdateTxStatusCall {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly patch: TxStatusPatch;
}

class FakePaymentTransactionsRepo {
  rows: PaymentTransaction[] = [];
  findByProviderRefCalls: Array<{ provider: string; providerRef: string }> = [];
  updateStatusCalls: UpdateTxStatusCall[] = [];

  findByProviderRef = (
    provider: string,
    providerRef: string,
  ): Promise<PaymentTransaction | null> => {
    this.findByProviderRefCalls.push({ provider, providerRef });
    return Promise.resolve(
      this.rows.find((r) => r.provider === provider && r.providerRef === providerRef) ?? null,
    );
  };

  updateStatus = (
    id: string,
    status: PaymentStatus,
    patch: TxStatusPatch = {},
  ): Promise<PaymentTransaction | null> => {
    this.updateStatusCalls.push({ id, status, patch });
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return Promise.resolve(null);
    row.status = status;
    if (patch.authorizedAt !== undefined) row.authorizedAt = patch.authorizedAt;
    if (patch.settledAt !== undefined) row.settledAt = patch.settledAt;
    if (patch.failedAt !== undefined) row.failedAt = patch.failedAt;
    if (patch.canceledAt !== undefined) row.canceledAt = patch.canceledAt;
    if (patch.failureCode !== undefined) row.failureCode = patch.failureCode;
    if (patch.failureReason !== undefined) row.failureReason = patch.failureReason;
    row.updatedAt = new Date('2026-05-02T13:00:00.000Z');
    return Promise.resolve(row);
  };
}

class FakeOrdersRepo {
  transitionStatusCalls: OrderStatusTransitionInput[] = [];

  transitionStatus = (input: OrderStatusTransitionInput): Promise<Order> => {
    this.transitionStatusCalls.push(input);
    // Service discards the return value; the cast keeps the signature
    // honest without forcing every test to assemble a full Order row.
    return Promise.resolve({ id: input.orderId, status: input.toStatus } as unknown as Order);
  };
}

function build(): {
  service: PaymentMethodsService;
  repo: FakePaymentMethodsRepo;
  txRepo: FakePaymentTransactionsRepo;
  ordersRepo: FakeOrdersRepo;
  aeropay: FakeAeropayClient;
} {
  const repo = new FakePaymentMethodsRepo();
  const txRepo = new FakePaymentTransactionsRepo();
  const ordersRepo = new FakeOrdersRepo();
  const aeropay = new FakeAeropayClient();
  const service = new PaymentMethodsService(
    repo as unknown as PaymentMethodsRepository,
    txRepo as unknown as PaymentTransactionsRepository,
    ordersRepo as unknown as OrdersRepository,
    aeropay,
  );
  return { service, repo, txRepo, ordersRepo, aeropay };
}

describe('PaymentMethodsService.list', () => {
  it('projects the user rows into the response shape (excluding deleted)', async () => {
    const { service, repo } = build();
    repo.rows.push(
      makeMethod({ id: '01935f3d-0000-7000-8000-000000000aaa' }),
      makeMethod({
        id: '01935f3d-0000-7000-8000-000000000bbb',
        userId: OTHER_USER_ID,
      }),
      makeMethod({
        id: '01935f3d-0000-7000-8000-000000000ccc',
        deletedAt: new Date('2026-04-01T00:00:00.000Z'),
      }),
    );

    const res = await service.list(USER_ID);

    expect(res.paymentMethods).toHaveLength(1);
    expect(res.paymentMethods[0]?.id).toBe('01935f3d-0000-7000-8000-000000000aaa');
    expect(res.paymentMethods[0]?.bankName).toBe('Test Bank');
    expect(res.paymentMethods[0]?.last4).toBe('1234');
    expect(res.paymentMethods[0]?.status).toBe('active');
    expect(res.paymentMethods[0]?.createdAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('returns an empty list when the user has no methods', async () => {
    const { service } = build();
    const res = await service.list(USER_ID);
    expect(res.paymentMethods).toEqual([]);
  });
});

describe('PaymentMethodsService.linkAeropay', () => {
  it('mints a hosted link session and persists a pending row', async () => {
    const { service, repo, aeropay } = build();

    const res = await service.linkAeropay(USER_ID, 'https://app.dankdash.com/link/return');

    expect(aeropay.linkCalls).toEqual([
      { customerRef: USER_ID, returnUrl: 'https://app.dankdash.com/link/return' },
    ]);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.status).toBe('pending');
    expect(repo.rows[0]?.aeropayPaymentMethodRef).toBe('link_session_test_1');
    expect(repo.rows[0]?.userId).toBe(USER_ID);
    expect(res.link.hostedUrl).toBe('https://link.aeropay.com/session/test_1');
    expect(res.link.id).toBe('link_session_test_1');
    expect(res.link.expiresAt).toBe('2026-05-01T03:00:00.000Z');
    expect(res.paymentMethod.status).toBe('pending');
  });

  it('refuses to mint a second link while one is already pending', async () => {
    const { service, repo } = build();
    repo.rows.push(
      makeMethod({
        id: '01935f3d-0000-7000-8000-000000000bbb',
        status: 'pending',
        aeropayPaymentMethodRef: 'link_session_test_existing',
      }),
    );

    await expect(
      service.linkAeropay(USER_ID, 'https://app.dankdash.com/link/return'),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_LINK_IN_PROGRESS',
    });
    await expect(
      service.linkAeropay(USER_ID, 'https://app.dankdash.com/link/return'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows a new link when prior rows are active or failed (only `pending` blocks)', async () => {
    const { service, repo } = build();
    repo.rows.push(makeMethod({ status: 'active' }));

    await expect(
      service.linkAeropay(USER_ID, 'https://app.dankdash.com/link/return'),
    ).resolves.toBeDefined();
    expect(repo.rows).toHaveLength(2);
  });
});

describe('PaymentMethodsService.delete', () => {
  it('soft-deletes a method the caller owns', async () => {
    const { service, repo } = build();
    repo.rows.push(makeMethod({ id: '01935f3d-0000-7000-8000-000000000aaa' }));

    await service.delete(USER_ID, '01935f3d-0000-7000-8000-000000000aaa');

    expect(repo.softDeleteCalls).toEqual(['01935f3d-0000-7000-8000-000000000aaa']);
    expect(repo.rows[0]?.deletedAt).not.toBeNull();
  });

  it('returns 404-shape for a method owned by another user', async () => {
    const { service, repo } = build();
    repo.rows.push(makeMethod({ userId: OTHER_USER_ID }));

    await expect(
      service.delete(USER_ID, '01935f3d-0000-7000-8000-000000000aaa'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.softDeleteCalls).toHaveLength(0);
  });

  it('returns 404-shape for a method that does not exist', async () => {
    const { service } = build();

    await expect(
      service.delete(USER_ID, '01935f3d-0000-7000-8000-000000000fff'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 404-shape for an already-deleted method', async () => {
    const { service, repo } = build();
    repo.rows.push(makeMethod({ deletedAt: new Date('2026-04-01T00:00:00.000Z') }));

    await expect(
      service.delete(USER_ID, '01935f3d-0000-7000-8000-000000000aaa'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('PaymentMethodsService.applyWebhook', () => {
  function bankAccount(overrides: Partial<AeropayBankAccount> = {}): AeropayBankAccount {
    return {
      id: 'ba_real_account_123',
      customerRef: USER_ID,
      status: 'linked',
      maskedAccountNumber: '******1234',
      institutionName: 'Test Bank',
      ...overrides,
    };
  }

  it('promotes a pending row to active on bank_account.linked', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({
        status: 'pending',
        aeropayPaymentMethodRef: 'link_session_test_1',
        bankName: null,
        last4: null,
      }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount());

    const outcome: AeropayWebhookOutcome = {
      type: 'bank_account.linked',
      eventId: 'evt_test_1',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    };

    await service.applyWebhook(outcome);

    expect(repo.updateBankAccountDetailsCalls).toHaveLength(1);
    const call = repo.updateBankAccountDetailsCalls[0];
    expect(call?.patch).toEqual({
      aeropayPaymentMethodRef: 'ba_real_account_123',
      bankName: 'Test Bank',
      last4: '1234',
      status: 'active',
    });
    expect(aeropay.getBankAccountCalls).toEqual(['ba_real_account_123']);
  });

  it('is a no-op when the same bank_account.linked arrives twice (replay)', async () => {
    const { service, repo, aeropay } = build();
    // Already active row keyed by the bank account id — second delivery
    // hits the direct lookup branch and short-circuits.
    repo.rows.push(
      makeMethod({
        status: 'active',
        aeropayPaymentMethodRef: 'ba_real_account_123',
      }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount());

    await service.applyWebhook({
      type: 'bank_account.linked',
      eventId: 'evt_test_1',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateBankAccountDetailsCalls).toHaveLength(0);
  });

  it('uses last4=null when the masked number has no trailing 4-digit run', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({ status: 'pending', aeropayPaymentMethodRef: 'link_session_test_1' }),
    );
    aeropay.bankAccountsById.set(
      'ba_real_account_123',
      bankAccount({ maskedAccountNumber: 'masked-no-digits' }),
    );

    await service.applyWebhook({
      type: 'bank_account.linked',
      eventId: 'evt_test_2',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateBankAccountDetailsCalls[0]?.patch.last4).toBeNull();
  });

  it('does nothing when no pending row exists for the customer', async () => {
    const { service, repo, aeropay } = build();
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount());

    await service.applyWebhook({
      type: 'bank_account.linked',
      eventId: 'evt_test_3',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateBankAccountDetailsCalls).toHaveLength(0);
    expect(repo.updateStatusCalls).toHaveLength(0);
  });

  it('does not match a row owned by a different user (direct ref guard)', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({
        userId: OTHER_USER_ID,
        status: 'active',
        aeropayPaymentMethodRef: 'ba_real_account_123',
      }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount());

    await service.applyWebhook({
      type: 'bank_account.linked',
      eventId: 'evt_test_4',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateBankAccountDetailsCalls).toHaveLength(0);
  });

  it('raises PAYMENT_METHOD_INVALID when the matched row vanishes during update', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({ status: 'pending', aeropayPaymentMethodRef: 'link_session_test_1' }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount());
    repo.returnNullOnUpdate = true;

    await expect(
      service.applyWebhook({
        type: 'bank_account.linked',
        eventId: 'evt_test_5',
        objectId: 'ba_real_account_123',
        occurredAt: new Date('2026-05-01T00:00:00.000Z'),
        raw: {},
      }),
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it('flips the pending row to failed on bank_account.failed', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({ status: 'pending', aeropayPaymentMethodRef: 'link_session_test_1' }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount({ status: 'failed' }));

    await service.applyWebhook({
      type: 'bank_account.failed',
      eventId: 'evt_test_6',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateStatusCalls).toEqual([{ id: repo.rows[0]?.id, status: 'failed' }]);
  });

  it('does nothing on bank_account.failed when the row is already failed (dedupe)', async () => {
    const { service, repo, aeropay } = build();
    repo.rows.push(
      makeMethod({ status: 'failed', aeropayPaymentMethodRef: 'ba_real_account_123' }),
    );
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount({ status: 'failed' }));

    await service.applyWebhook({
      type: 'bank_account.failed',
      eventId: 'evt_test_7',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateStatusCalls).toHaveLength(0);
  });

  it('does nothing on bank_account.failed when no row matches', async () => {
    const { service, repo, aeropay } = build();
    aeropay.bankAccountsById.set('ba_real_account_123', bankAccount({ status: 'failed' }));

    await service.applyWebhook({
      type: 'bank_account.failed',
      eventId: 'evt_test_8',
      objectId: 'ba_real_account_123',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(repo.updateStatusCalls).toHaveLength(0);
  });

  it('noops on an ignored event type', async () => {
    const { service, repo, aeropay } = build();

    await service.applyWebhook({
      type: 'ignored',
      eventName: 'something.unrecognized',
      eventId: 'evt_test_9',
    });

    expect(aeropay.getBankAccountCalls).toHaveLength(0);
    expect(repo.updateStatusCalls).toHaveLength(0);
    expect(repo.updateBankAccountDetailsCalls).toHaveLength(0);
  });

  it('noops on payment.refunded (handled by the refunds service in 6.5)', async () => {
    const { service, repo, txRepo, ordersRepo, aeropay } = build();

    await service.applyWebhook({
      type: 'payment.refunded',
      eventId: 'evt_test_10',
      objectId: 'pay_test_refunded',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(aeropay.getBankAccountCalls).toHaveLength(0);
    expect(repo.updateStatusCalls).toHaveLength(0);
    expect(txRepo.findByProviderRefCalls).toHaveLength(0);
    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });

  it('noops on payout.* events (handled by the payouts cron in 6.6)', async () => {
    const { service, repo, txRepo, ordersRepo } = build();

    await service.applyWebhook({
      type: 'payout.paid',
      eventId: 'evt_test_11',
      objectId: 'po_test_1',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });
    await service.applyWebhook({
      type: 'payout.failed',
      eventId: 'evt_test_12',
      objectId: 'po_test_2',
      occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      raw: {},
    });

    expect(txRepo.findByProviderRefCalls).toHaveLength(0);
    expect(repo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });
});

describe('PaymentMethodsService.applyWebhook — payment.authorized', () => {
  it('flips an initiated payment row to authorized and stamps authorizedAt', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'initiated' }));

    await service.applyWebhook({
      type: 'payment.authorized',
      eventId: 'evt_pay_auth_1',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.findByProviderRefCalls).toEqual([
      { provider: 'aeropay', providerRef: AEROPAY_PAYMENT_ID },
    ]);
    expect(txRepo.updateStatusCalls).toEqual([
      {
        id: PAYMENT_TX_ID,
        status: 'authorized',
        patch: { authorizedAt: WEBHOOK_OCCURRED_AT },
      },
    ]);
  });

  it('is a no-op when the row is already authorized (replay)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'authorized' }));

    await service.applyWebhook({
      type: 'payment.authorized',
      eventId: 'evt_pay_auth_2',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('is a no-op when the row is already settled (do not regress)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'settled' }));

    await service.applyWebhook({
      type: 'payment.authorized',
      eventId: 'evt_pay_auth_3',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('does nothing when the late event arrives on a terminal failed row', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'failed' }));

    await service.applyWebhook({
      type: 'payment.authorized',
      eventId: 'evt_pay_auth_4',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('does nothing when no payment_transactions row matches the provider ref', async () => {
    const { service, txRepo, ordersRepo } = build();

    await service.applyWebhook({
      type: 'payment.authorized',
      eventId: 'evt_pay_auth_5',
      objectId: 'pay_unknown_999',
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.findByProviderRefCalls).toEqual([
      { provider: 'aeropay', providerRef: 'pay_unknown_999' },
    ]);
    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });
});

describe('PaymentMethodsService.applyWebhook — payment.settled', () => {
  it('flips an authorized row to settled and stamps settledAt', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(
      makePaymentTransaction({
        status: 'authorized',
        authorizedAt: new Date('2026-05-02T10:00:00.000Z'),
      }),
    );

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_1',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toEqual([
      {
        id: PAYMENT_TX_ID,
        status: 'settled',
        patch: { settledAt: WEBHOOK_OCCURRED_AT },
      },
    ]);
  });

  it('also accepts a settle that arrives without an intermediate authorize', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'initiated' }));

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_2',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toEqual([
      {
        id: PAYMENT_TX_ID,
        status: 'settled',
        patch: { settledAt: WEBHOOK_OCCURRED_AT },
      },
    ]);
  });

  it('is a no-op when the row is already settled (replay)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'settled' }));

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_3',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('refuses to re-settle a row that is already failed (terminal guard)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'failed' }));

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_4',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('refuses to settle a canceled row (terminal guard)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'canceled' }));

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_5',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('does nothing when no payment_transactions row matches', async () => {
    const { service, txRepo } = build();

    await service.applyWebhook({
      type: 'payment.settled',
      eventId: 'evt_pay_settled_6',
      objectId: 'pay_unknown_settle',
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });
});

describe('PaymentMethodsService.applyWebhook — payment.failed', () => {
  it('marks the payment failed and transitions the parent order to payment_failed', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'authorized' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_1',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {
        data: {
          object: {
            failure_code: 'insufficient_funds',
            failure_reason: 'The bank account has insufficient funds.',
          },
        },
      },
    });

    expect(txRepo.updateStatusCalls).toEqual([
      {
        id: PAYMENT_TX_ID,
        status: 'failed',
        patch: {
          failedAt: WEBHOOK_OCCURRED_AT,
          failureCode: 'insufficient_funds',
          failureReason: 'The bank account has insufficient funds.',
        },
      },
    ]);
    expect(ordersRepo.transitionStatusCalls).toEqual([
      {
        orderId: ORDER_ID,
        toStatus: 'payment_failed',
        eventType: 'payment_failed',
        payload: {
          paymentTransactionId: PAYMENT_TX_ID,
          aeropayPaymentId: AEROPAY_PAYMENT_ID,
          failureCode: 'insufficient_funds',
          failureReason: 'The bank account has insufficient funds.',
        },
      },
    ]);
  });

  it('records null failure details when the envelope omits them', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'initiated' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_2',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls[0]?.patch).toEqual({
      failedAt: WEBHOOK_OCCURRED_AT,
      failureCode: null,
      failureReason: null,
    });
    expect(ordersRepo.transitionStatusCalls[0]?.payload).toEqual({
      paymentTransactionId: PAYMENT_TX_ID,
      aeropayPaymentId: AEROPAY_PAYMENT_ID,
      failureCode: null,
      failureReason: null,
    });
  });

  it('drops non-string failure_code / failure_reason values (raw is unknown)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'initiated' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_3',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {
        data: {
          object: {
            failure_code: 42,
            failure_reason: ['nope'],
          },
        },
      },
    });

    expect(txRepo.updateStatusCalls[0]?.patch.failureCode).toBeNull();
    expect(txRepo.updateStatusCalls[0]?.patch.failureReason).toBeNull();
  });

  it('does not regress a row that already settled (skip and noop the order)', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'settled' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_4',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });

  it('does nothing for a row that is already failed (replay)', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'failed' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_5',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });

  it('does nothing for a canceled row (terminal guard)', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'canceled' }));

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_6',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });

  it('does nothing when no payment_transactions row matches', async () => {
    const { service, txRepo, ordersRepo } = build();

    await service.applyWebhook({
      type: 'payment.failed',
      eventId: 'evt_pay_failed_7',
      objectId: 'pay_unknown_failed',
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });
});

describe('PaymentMethodsService.applyWebhook — payment.canceled', () => {
  it('flips an initiated payment row to canceled and stamps canceledAt', async () => {
    const { service, txRepo, ordersRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'initiated' }));

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_1',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toEqual([
      {
        id: PAYMENT_TX_ID,
        status: 'canceled',
        patch: { canceledAt: WEBHOOK_OCCURRED_AT },
      },
    ]);
    // The order intentionally stays in `placed`; the cancellation must
    // run through the explicit cancel flow with its own auditing.
    expect(ordersRepo.transitionStatusCalls).toHaveLength(0);
  });

  it('also cancels an authorized row (Aeropay can cancel pre-settle)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'authorized' }));

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_2',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls[0]?.status).toBe('canceled');
  });

  it('is a no-op when the row is already canceled (replay)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'canceled' }));

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_3',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('refuses to cancel a settled row (terminal guard)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'settled' }));

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_4',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('refuses to cancel a failed row (terminal guard)', async () => {
    const { service, txRepo } = build();
    txRepo.rows.push(makePaymentTransaction({ status: 'failed' }));

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_5',
      objectId: AEROPAY_PAYMENT_ID,
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });

  it('does nothing when no payment_transactions row matches', async () => {
    const { service, txRepo } = build();

    await service.applyWebhook({
      type: 'payment.canceled',
      eventId: 'evt_pay_canceled_6',
      objectId: 'pay_unknown_canceled',
      occurredAt: WEBHOOK_OCCURRED_AT,
      raw: {},
    });

    expect(txRepo.updateStatusCalls).toHaveLength(0);
  });
});
