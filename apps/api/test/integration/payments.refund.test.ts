/**
 * /v1/vendor/orders/:id/refund + /v1/admin/refunds/:id/approve —
 * end-to-end refund lifecycle against the real NestJS DI graph + real
 * Postgres + the real RefundsService.
 *
 * Phase 6.8 coverage map (see CLAUDE-CODE-PHASES.md §6.8):
 *   - Vendor auto-approve branch: amount ≤ $50 → refund row goes straight
 *     to `completed`, reverse-ledger entries land, payment_transactions
 *     flips to `partially_refunded`.
 *   - Vendor → admin approve branch: amount > $50 → row stays `pending`
 *     after POST /vendor/.../refund (no upstream Aeropay call, no
 *     ledger writes), then a *different* user with admin role POSTs
 *     /admin/refunds/:id/approve and finalizes.
 *   - Separation of duties: an admin trying to approve a refund they
 *     themselves initiated gets 422 and the row stays pending.
 *   - Reverse-ledger balance invariant: sum(debits) === sum(credits)
 *     across every refund leg (DR refund_reserve + CR customer).
 *
 * The flow always starts by driving an order through checkout +
 * payment.settled webhook so the payment_transactions row is in
 * `settled` (the only state RefundsService treats as refundable on the
 * first refund of an order).
 *
 * Aeropay is faked via AEROPAY_CLIENT override. Both createPayment (for
 * checkout) and refundPayment (for the refund finalize path) return
 * synthetic ids; cancel/getPayment/etc. throw to surface any accidental
 * call that doesn't belong in this flow.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  type AeropayBankAccount,
  type AeropayPayment,
  type AeropayPaymentStatus,
  type CreatePaymentInput,
  type RefundPaymentInput,
} from '@dankdash/aeropay';
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../../src/modules/payments/tokens.js';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, seedFixtures, signTokenFor } from './setup.js';

const ALICE_ADDRESS_ID = stableUuid('address', 'addr-alice-home');
const ALICE_PAYMENT_METHOD_ID = stableUuid('payment-method', 'pm-alice');
const MPLS_NORTHERN_LIGHTS_LISTING_ID = SEED_IDS.listing.mplsNorthernLights7g;
const WEBHOOK_SECRET = 'test';

// Auto-approve threshold from packages/payments dto. Repeated here as a
// literal so the test pins the production cutoff — if the limit changes
// the test must update deliberately.
const AUTO_APPROVE_LIMIT_CENTS = 5_000;

interface CheckoutBody {
  readonly order: { readonly id: string; readonly totalCents: number };
  readonly paymentIntent: { readonly id: string; readonly providerRef: string };
}

interface RefundEnvelope {
  readonly refund: {
    readonly id: string;
    readonly status: 'pending' | 'completed' | 'failed' | 'canceled';
    readonly providerRef: string | null;
    readonly completedAt: string | null;
    readonly requiresAdminApproval: boolean;
  };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

interface LedgerRow {
  readonly account_type: string;
  readonly account_ref: string | null;
  readonly refund_id: string | null;
  readonly debit_cents: number | string;
  readonly credit_cents: number | string;
}

interface PaymentTransactionRow {
  readonly id: string;
  readonly status: string;
  readonly amount_cents: number | string;
}

function coerceToError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

class FakeAeropayClient implements AeropayClientLike {
  public readonly createCalls: CreatePaymentInput[] = [];
  public readonly refundCalls: RefundPaymentInput[] = [];
  public nextStatus: AeropayPaymentStatus = 'initiated';
  public nextRefundThrow: unknown = null;
  private idSeq = 1;
  private refundSeq = 1;

  createPayment = (input: CreatePaymentInput): Promise<AeropayPayment> => {
    this.createCalls.push(input);
    return Promise.resolve({
      id: `pay_test_${String(this.idSeq++).padStart(6, '0')}`,
      status: this.nextStatus,
      amountCents: input.amountCents,
      bankAccountId: input.bankAccountId,
      customerRef: input.customerRef,
      orderRef: input.orderRef,
      createdAt: new Date(),
    });
  };

  refundPayment = (input: RefundPaymentInput): Promise<AeropayPayment> => {
    this.refundCalls.push(input);
    if (this.nextRefundThrow !== null) {
      const err = this.nextRefundThrow;
      this.nextRefundThrow = null;
      return Promise.reject(coerceToError(err));
    }
    return Promise.resolve({
      id: `ref_test_${String(this.refundSeq++).padStart(6, '0')}`,
      status: 'refunded',
      amountCents: input.amountCents,
      // The AeropayPayment shape requires these to be non-null strings;
      // Aeropay echoes them back on the refund record. Use stable
      // placeholders so the contract is satisfied — the refund service
      // ignores everything except `id` and `status`.
      bankAccountId: 'ba_test_refund',
      customerRef: `cust_refund_${input.paymentId}`,
      orderRef: `ord_refund_${input.paymentId}`,
      createdAt: new Date(),
    });
  };

  linkBankAccount = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.linkBankAccount: not used in refund flow'));
  getBankAccount = (_id: string): Promise<AeropayBankAccount> =>
    Promise.reject(new Error('FakeAeropayClient.getBankAccount: not used in refund flow'));
  getPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.getPayment: not used in refund flow'));
  cancelPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.cancelPayment: not used in refund flow'));
  createPayout = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.createPayout: not used in refund flow'));
}

function signWebhook(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function settleEnvelope(eventId: string, aeropayPaymentId: string): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment.settled',
    created_at: new Date().toISOString(),
    data: { object: { id: aeropayPaymentId } },
  });
}

describe('/v1/vendor/orders/:id/refund + /v1/admin/refunds/:id/approve — Phase 6.8', () => {
  let app: NestFastifyApplication;
  let aeropay: FakeAeropayClient;

  beforeAll(async () => {
    aeropay = new FakeAeropayClient();
    app = await buildTestApp({
      overrides: [{ token: AEROPAY_CLIENT, value: aeropay }],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    await force24HourHours();
    aeropay.createCalls.length = 0;
    aeropay.refundCalls.length = 0;
    aeropay.nextStatus = 'initiated';
    aeropay.nextRefundThrow = null;
  });

  it('auto-approves a small refund (≤ $50) inline: row completes, ledger balances, partially_refunded flip', async () => {
    const checkout = await settledCheckoutForAlice(app, aeropay);
    const ledgerBefore = await fetchRefundLedger(checkout.order.id);
    expect(ledgerBefore).toHaveLength(0);

    const budtenderToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsBudtender,
      role: 'budtender',
    });
    const resp = await app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${checkout.order.id}/refund`,
      headers: {
        ...bearer(budtenderToken),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: { amountCents: 2_500, reasonCode: 'customer_request' },
    });
    expect(resp.statusCode, resp.body).toBe(201);
    const { refund } = resp.json<RefundEnvelope>();

    expect(refund.status).toBe('completed');
    expect(refund.requiresAdminApproval).toBe(false);
    expect(refund.providerRef).toMatch(/^ref_test_\d{6}$/);
    expect(refund.completedAt).not.toBeNull();

    // Aeropay refundPayment was called with the refund-row idempotency key.
    expect(aeropay.refundCalls).toHaveLength(1);
    expect(aeropay.refundCalls[0]?.idempotencyKey).toBe(`refund:${refund.id}`);
    expect(aeropay.refundCalls[0]?.amountCents).toBe(2_500);

    // Reverse-ledger landed: DR refund_reserve $25 / CR customer $25.
    const refundLedger = await fetchRefundLedger(checkout.order.id);
    expect(refundLedger).toHaveLength(2);
    const byType = new Map(refundLedger.map((r) => [r.account_type, r]));
    expect(byType.get('refund_reserve')).toMatchObject({
      account_ref: SEED_IDS.dispensary.mpls,
      refund_id: refund.id,
    });
    expect(Number(byType.get('refund_reserve')?.debit_cents)).toBe(2_500);
    expect(Number(byType.get('refund_reserve')?.credit_cents)).toBe(0);
    expect(byType.get('customer')).toMatchObject({
      account_ref: SEED_IDS.user.customer1,
      refund_id: refund.id,
    });
    expect(Number(byType.get('customer')?.credit_cents)).toBe(2_500);
    expect(Number(byType.get('customer')?.debit_cents)).toBe(0);
    assertRefundBalanced(refundLedger, 2_500);

    // The settled tx now reads `partially_refunded` (refund < charge).
    const txns = await fetchPaymentTransactionsForOrder(checkout.order.id);
    expect(txns[0]?.status).toBe('partially_refunded');
  });

  it('vendor refund > $50 stays pending and admin approval finalizes it', async () => {
    const checkout = await settledCheckoutForAlice(app, aeropay);

    // Use a real admin user UUID so the FK on refunds.approved_by holds.
    // The role on the JWT is what RolesGuard checks; the user row itself
    // does not need to carry an "admin" role.
    const adminUserId = await ensureAdminUser();
    const budtenderToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsBudtender,
      role: 'budtender',
    });
    const adminToken = signTokenFor(app, { userId: adminUserId, role: 'admin' });

    const initiate = await app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${checkout.order.id}/refund`,
      headers: {
        ...bearer(budtenderToken),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: {
        amountCents: AUTO_APPROVE_LIMIT_CENTS + 1,
        reasonCode: 'damaged_product',
        reasonNotes: 'package crushed in transit',
      },
    });
    expect(initiate.statusCode, initiate.body).toBe(201);
    const { refund: pending } = initiate.json<RefundEnvelope>();

    expect(pending.status).toBe('pending');
    expect(pending.requiresAdminApproval).toBe(true);
    expect(pending.providerRef).toBeNull();
    expect(pending.completedAt).toBeNull();
    // Pending refund must NOT have called Aeropay or written ledger rows.
    expect(aeropay.refundCalls).toHaveLength(0);
    expect(await fetchRefundLedger(checkout.order.id)).toHaveLength(0);

    // Admin (different user) approves. No body — Fastify rejects an
    // empty application/json POST as 400, so omit the content-type.
    const approve = await app.inject({
      method: 'POST',
      url: `/v1/admin/refunds/${pending.id}/approve`,
      headers: bearer(adminToken),
    });
    expect(approve.statusCode, approve.body).toBe(201);
    const { refund: completed } = approve.json<RefundEnvelope>();

    expect(completed.status).toBe('completed');
    expect(completed.providerRef).toMatch(/^ref_test_\d{6}$/);
    expect(completed.completedAt).not.toBeNull();
    expect(aeropay.refundCalls).toHaveLength(1);
    expect(aeropay.refundCalls[0]?.idempotencyKey).toBe(`refund:${pending.id}`);
    expect(aeropay.refundCalls[0]?.amountCents).toBe(AUTO_APPROVE_LIMIT_CENTS + 1);

    const refundLedger = await fetchRefundLedger(checkout.order.id);
    expect(refundLedger).toHaveLength(2);
    assertRefundBalanced(refundLedger, AUTO_APPROVE_LIMIT_CENTS + 1);
  });

  it('separation of duties: admin cannot approve a refund they initiated themselves (422, row stays pending)', async () => {
    const checkout = await settledCheckoutForAlice(app, aeropay);

    // Same human in both seats — the budtender ALSO has the admin role on
    // their JWT (synthetic-but-plausible — a dispensary owner who is also
    // a platform admin). The DB CHECK + service preflight must reject the
    // self-approval before any state changes.
    const dualRoleToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsBudtender,
      role: 'budtender',
    });
    const sameUserAdminToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsBudtender,
      role: 'admin',
    });

    const initiate = await app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${checkout.order.id}/refund`,
      headers: {
        ...bearer(dualRoleToken),
        'x-dispensary-id': SEED_IDS.dispensary.mpls,
        'content-type': 'application/json',
      },
      payload: { amountCents: AUTO_APPROVE_LIMIT_CENTS + 100, reasonCode: 'customer_request' },
    });
    expect(initiate.statusCode, initiate.body).toBe(201);
    const { refund: pending } = initiate.json<RefundEnvelope>();
    expect(pending.status).toBe('pending');

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/admin/refunds/${pending.id}/approve`,
      headers: bearer(sameUserAdminToken),
    });
    expect(approve.statusCode, approve.body).toBe(422);
    const body = approve.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/separation of duties/iu);

    // No state changes from the rejected approval.
    expect(aeropay.refundCalls).toHaveLength(0);
    expect(await fetchRefundLedger(checkout.order.id)).toHaveLength(0);
    const row = await fetchRefundRow(pending.id);
    expect(row?.status).toBe('pending');
    expect(row?.approved_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRefundBalanced(rows: readonly LedgerRow[], expectedAmountCents: number): void {
  const debits = rows.reduce((acc, r) => acc + Number(r.debit_cents), 0);
  const credits = rows.reduce((acc, r) => acc + Number(r.credit_cents), 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(expectedAmountCents);
}

async function force24HourHours(): Promise<void> {
  await getPool().sql.unsafe(`UPDATE dispensaries SET hours_json = $1::jsonb`, [
    JSON.stringify({
      mon: { open: '00:00', close: '23:59' },
      tue: { open: '00:00', close: '23:59' },
      wed: { open: '00:00', close: '23:59' },
      thu: { open: '00:00', close: '23:59' },
      fri: { open: '00:00', close: '23:59' },
      sat: { open: '00:00', close: '23:59' },
      sun: { open: '00:00', close: '23:59' },
    }),
  ]);
}

async function settledCheckoutForAlice(
  app: NestFastifyApplication,
  aeropay: FakeAeropayClient,
): Promise<CheckoutBody> {
  const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });

  const cartCreate = await app.inject({
    method: 'POST',
    url: '/v1/carts',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { dispensaryId: SEED_IDS.dispensary.mpls },
  });
  expect(cartCreate.statusCode, cartCreate.body).toBe(201);
  const cart = cartCreate.json<{ id: string }>();
  const addItem = await app.inject({
    method: 'POST',
    url: `/v1/carts/${cart.id}/items`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity: 2 },
  });
  expect(addItem.statusCode, addItem.body).toBe(201);

  const checkout = await app.inject({
    method: 'POST',
    url: `/v1/carts/${cart.id}/checkout`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: {
      deliveryAddressId: ALICE_ADDRESS_ID,
      paymentMethodId: ALICE_PAYMENT_METHOD_ID,
      driverTipCents: 500,
    },
  });
  expect(checkout.statusCode, checkout.body).toBe(201);
  const body = checkout.json<CheckoutBody>();

  // Settle through the real webhook so the payment_transactions row reads
  // `settled` (the only state RefundsService treats as refundable here).
  const envelope = settleEnvelope(`evt_settle_${body.order.id}`, body.paymentIntent.providerRef);
  const settle = await app.inject({
    method: 'POST',
    url: '/v1/payment-methods/aeropay/webhook',
    headers: { 'content-type': 'application/json', 'aeropay-signature': signWebhook(envelope) },
    payload: envelope,
  });
  expect(settle.statusCode, settle.body).toBe(204);

  // Silence the unused-aeropay-arg lint by reading the most recent
  // createPayment so callers can additionally assert against it if needed.
  expect(aeropay.createCalls.at(-1)?.orderRef).toBe(body.order.id);
  return body;
}

async function fetchRefundLedger(orderId: string): Promise<readonly LedgerRow[]> {
  return getPool().sql.unsafe<LedgerRow[]>(
    `SELECT account_type, account_ref, refund_id, debit_cents, credit_cents
       FROM ledger_entries
      WHERE order_id = $1 AND refund_id IS NOT NULL`,
    [orderId],
  );
}

async function fetchPaymentTransactionsForOrder(
  orderId: string,
): Promise<readonly PaymentTransactionRow[]> {
  return getPool().sql.unsafe<PaymentTransactionRow[]>(
    `SELECT id, status, amount_cents FROM payment_transactions WHERE order_id = $1`,
    [orderId],
  );
}

async function fetchRefundRow(
  refundId: string,
): Promise<{ readonly status: string; readonly approved_by: string | null } | null> {
  const rows = await getPool().sql.unsafe<
    Array<{ readonly status: string; readonly approved_by: string | null }>
  >(`SELECT status, approved_by FROM refunds WHERE id = $1`, [refundId]);
  return rows[0] ?? null;
}

/**
 * Insert a synthetic admin user row so the `refunds.approved_by` FK is
 * satisfied. The user's `role` column is left at 'customer' — admin
 * powers come from the JWT, not the users row, which mirrors how
 * RolesGuard actually reads the principal.
 */
async function ensureAdminUser(): Promise<string> {
  const id = randomUUID();
  const email = `admin-${id.slice(0, 8)}@example.test`;
  await getPool().sql.unsafe(
    `INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at)
     VALUES ($1, $2, '$argon2id$v=19$m=65536,t=3,p=4$test$test', 'customer', 'active', now(), now())`,
    [id, email],
  );
  return id;
}
