/**
 * /v1/payment-methods/aeropay/webhook — full payment lifecycle against
 * the real NestJS DI graph, real Postgres, and the real HMAC verifier.
 *
 * Phase 6.8 coverage map (see CLAUDE-CODE-PHASES.md §6.8):
 *   - Happy path: create order → payment.authorized → payment.settled →
 *     ledger writes balanced (sum debits = sum credits)
 *   - Webhook signature invalid → 401, no DB writes
 *   - Webhook replay (same event id) → 204 dedup, single ledger,
 *     no double-settlement (idempotency from Phase 6.7's
 *     webhook_events_processed)
 *   - Ledger invariant: every order with settled ledger entries has
 *     balanced debits == credits
 *
 * The test signs payloads with the test webhook secret (AEROPAY_WEBHOOK_SECRET
 * = 'test' from env-setup) so the real AeropayWebhookVerifier runs in-band.
 * Outbound Aeropay HTTP is stubbed via the FakeAeropayClient override on
 * AEROPAY_CLIENT so the suite stays hermetic.
 */
import { createHmac } from 'node:crypto';
import {
  type AeropayBankAccount,
  type AeropayPayment,
  type AeropayPaymentStatus,
  type CreatePaymentInput,
} from '@dankdash/aeropay';
import { stableUuid } from '@dankdash/db';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../../src/modules/payments/tokens.js';
import { buildTestApp } from '../helpers/build-app.js';
import {
  SEED_IDS,
  bearer,
  freezeToBusinessHours,
  getPool,
  resetRateLimit,
  restoreClock,
  seedFixtures,
  signTokenFor,
} from './setup.js';

const ALICE_ADDRESS_ID = stableUuid('address', 'addr-alice-home');
const ALICE_PAYMENT_METHOD_ID = stableUuid('payment-method', 'pm-alice');
const MPLS_NORTHERN_LIGHTS_LISTING_ID = SEED_IDS.listing.mplsNorthernLights7g;

const WEBHOOK_SECRET = 'test';

interface CartBody {
  readonly id: string;
}

interface CheckoutBody {
  readonly order: {
    readonly id: string;
    readonly totalCents: number;
  };
  readonly paymentIntent: {
    readonly id: string;
    readonly providerRef: string;
    readonly amountCents: number;
  };
}

interface PaymentTransactionRow {
  readonly id: string;
  readonly provider_ref: string;
  readonly status: string;
  readonly amount_cents: number | string;
  readonly authorized_at: Date | null;
  readonly settled_at: Date | null;
}

interface LedgerRow {
  readonly order_id: string;
  readonly account_type: string;
  readonly account_ref: string | null;
  readonly debit_cents: number | string;
  readonly credit_cents: number | string;
}

interface WebhookEventRow {
  readonly event_id: string;
  readonly provider: string;
  readonly event_type: string;
}

function coerceToError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * Fakes outbound Aeropay HTTP. Same pattern as checkout.flow.test.ts —
 * records calls so we can pin idempotency keys / amounts, returns a
 * synthetic id whose status defaults to 'initiated' (i.e. the checkout
 * controller path that subsequent payment.* webhooks will lift forward).
 */
class FakeAeropayClient implements AeropayClientLike {
  public readonly createCalls: CreatePaymentInput[] = [];
  public nextStatus: AeropayPaymentStatus = 'initiated';
  public nextThrow: unknown = null;
  private idSeq = 1;

  createPayment = (input: CreatePaymentInput): Promise<AeropayPayment> => {
    this.createCalls.push(input);
    if (this.nextThrow !== null) {
      const err = this.nextThrow;
      this.nextThrow = null;
      return Promise.reject(coerceToError(err));
    }
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

  // bank_account.* webhooks are out of scope here.
  linkBankAccount = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.linkBankAccount: not used in webhook flow'));
  getBankAccount = (_id: string): Promise<AeropayBankAccount> =>
    Promise.reject(new Error('FakeAeropayClient.getBankAccount: not used in webhook flow'));
  getPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.getPayment: not used in webhook flow'));
  cancelPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.cancelPayment: not used in webhook flow'));
  refundPayment = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.refundPayment: not used in webhook flow'));
  createPayout = (): Promise<never> =>
    Promise.reject(new Error('FakeAeropayClient.createPayout: not used in webhook flow'));
}

function signWebhook(
  rawBody: string,
  secret: string = WEBHOOK_SECRET,
  ts: number = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function paymentEvelope(input: {
  eventId: string;
  type:
    | 'payment.authorized'
    | 'payment.settled'
    | 'payment.failed'
    | 'payment.canceled'
    | 'payment.refunded';
  aeropayPaymentId: string;
  occurredAt?: Date;
  extraObject?: Readonly<Record<string, unknown>>;
}): string {
  const body = {
    id: input.eventId,
    type: input.type,
    created_at: (input.occurredAt ?? new Date()).toISOString(),
    data: {
      object: {
        id: input.aeropayPaymentId,
        ...(input.extraObject ?? {}),
      },
    },
  };
  return JSON.stringify(body);
}

describe('/v1/payment-methods/aeropay/webhook — Phase 6.8 lifecycle', () => {
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
    // Each case drives a real checkout (compliance-gated) before exercising
    // the webhook; pin the clock inside MN sale hours for determinism. The
    // webhook tolerance check uses the same in-process (frozen) clock and
    // the test builds `created_at` under it too, so they stay coherent.
    freezeToBusinessHours();
    await seedFixtures();
    await force24HourHours();
    // Frozen clock => static rate-limit window; clear between tests.
    resetRateLimit(app);
    aeropay.createCalls.length = 0;
    aeropay.nextStatus = 'initiated';
    aeropay.nextThrow = null;
  });

  afterEach(() => {
    restoreClock();
  });

  it('full lifecycle: checkout → payment.authorized → payment.settled → balanced distribution ledger', async () => {
    const checkout = await createCheckoutForAlice(app);
    const aeropayPaymentId = checkout.paymentIntent.providerRef;

    // 1. payment.authorized lifts the transaction off 'initiated'.
    const authorizedAt = new Date();
    const authorizedBody = paymentEvelope({
      eventId: 'evt_auth_1',
      type: 'payment.authorized',
      aeropayPaymentId,
      occurredAt: authorizedAt,
    });
    const authorizedResp = await app.inject({
      method: 'POST',
      url: '/v1/payment-methods/aeropay/webhook',
      headers: {
        'content-type': 'application/json',
        'aeropay-signature': signWebhook(authorizedBody),
      },
      payload: authorizedBody,
    });
    expect(authorizedResp.statusCode).toBe(204);

    const afterAuth = await fetchPaymentTransactionsForOrder(checkout.order.id);
    expect(afterAuth).toHaveLength(1);
    expect(afterAuth[0]?.status).toBe('authorized');
    expect(afterAuth[0]?.authorized_at).not.toBeNull();
    // Only the 2 placement-time entries exist — the settlement/distribution
    // legs are written by payment.settled, not by payment.authorized.
    const afterAuthLedger = await fetchLedgerForOrder(checkout.order.id);
    expect(afterAuthLedger).toHaveLength(2);
    expect(afterAuthLedger.map((r) => r.account_type).sort()).toEqual([
      'aeropay_clearing',
      'customer',
    ]);

    // 2. payment.settled flips status, writes the distribution ledger,
    // and emits a webhook_events_processed row keyed by the event id.
    const settledAt = new Date();
    const settledBody = paymentEvelope({
      eventId: 'evt_settle_1',
      type: 'payment.settled',
      aeropayPaymentId,
      occurredAt: settledAt,
    });
    const settledResp = await app.inject({
      method: 'POST',
      url: '/v1/payment-methods/aeropay/webhook',
      headers: {
        'content-type': 'application/json',
        'aeropay-signature': signWebhook(settledBody),
      },
      payload: settledBody,
    });
    expect(settledResp.statusCode).toBe(204);

    const afterSettle = await fetchPaymentTransactionsForOrder(checkout.order.id);
    expect(afterSettle[0]?.status).toBe('settled');
    expect(afterSettle[0]?.settled_at).not.toBeNull();

    // 3. Full ledger is balanced — placement (2) + settlement-clearing (2) +
    // distribution (≥2 depending on which legs are non-zero).
    const ledger = await fetchLedgerForOrder(checkout.order.id);
    expect(ledger.length).toBeGreaterThanOrEqual(6);
    assertBalanced(ledger, checkout.order.totalCents);

    // 4. Dedup table now records both events.
    const dedupRows = await fetchWebhookEvents(['evt_auth_1', 'evt_settle_1']);
    expect(dedupRows).toHaveLength(2);
    expect(dedupRows.map((r) => r.event_type).sort()).toEqual([
      'payment.authorized',
      'payment.settled',
    ]);
    for (const row of dedupRows) {
      expect(row.provider).toBe('aeropay');
    }
  });

  it('forged signature → 401 and no rows written to dedup or ledger', async () => {
    const checkout = await createCheckoutForAlice(app);
    const aeropayPaymentId = checkout.paymentIntent.providerRef;

    const body = paymentEvelope({
      eventId: 'evt_forged_1',
      type: 'payment.settled',
      aeropayPaymentId,
    });
    // Sign with the wrong secret — the verifier must reject.
    const badHeader = signWebhook(body, 'not-the-real-secret');

    const resp = await app.inject({
      method: 'POST',
      url: '/v1/payment-methods/aeropay/webhook',
      headers: { 'content-type': 'application/json', 'aeropay-signature': badHeader },
      payload: body,
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.json<{ error: { code: string } }>().error.code).toBe(
      'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
    );

    // No state changes from the rejected webhook. The 2 placement ledger
    // rows from checkout are present (and unchanged), no settlement ledger
    // rows were written, and no dedup row was planted (a forged signature
    // must never poison the idempotency table for a later legitimate event).
    const txns = await fetchPaymentTransactionsForOrder(checkout.order.id);
    expect(txns[0]?.status).toBe('initiated');
    const placementLedger = await fetchLedgerForOrder(checkout.order.id);
    expect(placementLedger).toHaveLength(2);
    expect(placementLedger.map((r) => r.account_type).sort()).toEqual([
      'aeropay_clearing',
      'customer',
    ]);
    expect(await fetchWebhookEvents(['evt_forged_1'])).toHaveLength(0);
  });

  it('webhook replay (same event id) → 204 dedup + no double-ledger', async () => {
    const checkout = await createCheckoutForAlice(app);
    const aeropayPaymentId = checkout.paymentIntent.providerRef;

    const body = paymentEvelope({
      eventId: 'evt_replay_1',
      type: 'payment.settled',
      aeropayPaymentId,
    });
    const header = signWebhook(body);

    // First delivery — applies the settlement.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/payment-methods/aeropay/webhook',
      headers: { 'content-type': 'application/json', 'aeropay-signature': header },
      payload: body,
    });
    expect(first.statusCode).toBe(204);

    const ledgerAfterFirst = await fetchLedgerForOrder(checkout.order.id);
    expect(ledgerAfterFirst.length).toBeGreaterThanOrEqual(6);
    const firstRowCount = ledgerAfterFirst.length;
    assertBalanced(ledgerAfterFirst, checkout.order.totalCents);

    // Re-sign with a fresh timestamp so the signature is valid but the
    // event id is the same — exactly Aeropay's retry pattern.
    const replayHeader = signWebhook(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) + 1);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/payment-methods/aeropay/webhook',
      headers: { 'content-type': 'application/json', 'aeropay-signature': replayHeader },
      payload: body,
    });
    expect(second.statusCode).toBe(204);

    // Ledger row count must be unchanged — replay is a no-op end-to-end.
    const ledgerAfterReplay = await fetchLedgerForOrder(checkout.order.id);
    expect(ledgerAfterReplay).toHaveLength(firstRowCount);
    assertBalanced(ledgerAfterReplay, checkout.order.totalCents);

    // Still exactly one dedup row for this event id.
    const dedup = await fetchWebhookEvents(['evt_replay_1']);
    expect(dedup).toHaveLength(1);
  });

  it('ledger invariant: every settled order has sum(debits) === sum(credits)', async () => {
    // Drive three independent checkouts + settlements through real webhooks.
    const checkouts = [
      await createCheckoutForAlice(app, { quantity: 1, tipCents: 0 }),
      await createCheckoutForAlice(app, { quantity: 1, tipCents: 250 }),
      await createCheckoutForAlice(app, { quantity: 1, tipCents: 1000 }),
    ];
    for (let i = 0; i < checkouts.length; i++) {
      const ck = checkouts[i]!;
      const body = paymentEvelope({
        eventId: `evt_invariant_${i}`,
        type: 'payment.settled',
        aeropayPaymentId: ck.paymentIntent.providerRef,
      });
      const resp = await app.inject({
        method: 'POST',
        url: '/v1/payment-methods/aeropay/webhook',
        headers: { 'content-type': 'application/json', 'aeropay-signature': signWebhook(body) },
        payload: body,
      });
      expect(resp.statusCode).toBe(204);
    }

    // Pull all settled-order ledger rows in one query and assert per-order
    // balance + the total reconciles to the orders.total_cents the
    // settlement closure debited.
    const rows = await getPool().sql.unsafe<LedgerRow[]>(
      `SELECT order_id, account_type, account_ref, debit_cents, credit_cents
         FROM ledger_entries
        WHERE order_id = ANY($1::uuid[])`,
      [checkouts.map((c) => c.order.id)],
    );
    expect(rows.length).toBeGreaterThanOrEqual(checkouts.length * 6);

    const byOrder = new Map<string, LedgerRow[]>();
    for (const row of rows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push(row);
      byOrder.set(row.order_id, list);
    }
    for (const ck of checkouts) {
      const list = byOrder.get(ck.order.id);
      expect(list, `no ledger rows for order ${ck.order.id}`).toBeDefined();
      assertBalanced(list!, ck.order.totalCents);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertBalanced(rows: readonly LedgerRow[], expectedTotalCents: number): void {
  const debits = rows.reduce((acc, r) => acc + Number(r.debit_cents), 0);
  const credits = rows.reduce((acc, r) => acc + Number(r.credit_cents), 0);
  expect(debits).toBe(credits);
  // Per-order debits cover three equal-to-total legs once payment is
  // settled: (1) the placement-time customer DR, (2) the settlement
  // aeropay_clearing DR that clears it, and (3) the distribution-time
  // customer DR that funds the parties — so the sum is 3× total.
  expect(debits).toBe(expectedTotalCents * 3);
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

async function createCheckoutForAlice(
  app: NestFastifyApplication,
  opts: { readonly quantity?: number; readonly tipCents?: number } = {},
): Promise<CheckoutBody> {
  const token = signTokenFor(app, { userId: SEED_IDS.user.customer1, role: 'customer' });
  const quantity = opts.quantity ?? 1;
  const tipCents = opts.tipCents ?? 500;

  const cartCreate = await app.inject({
    method: 'POST',
    url: '/v1/carts',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { dispensaryId: SEED_IDS.dispensary.mpls },
  });
  expect(cartCreate.statusCode, `create cart: ${cartCreate.body}`).toBe(201);
  const cart = cartCreate.json<CartBody>();
  const addItem = await app.inject({
    method: 'POST',
    url: `/v1/carts/${cart.id}/items`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: { listingId: MPLS_NORTHERN_LIGHTS_LISTING_ID, quantity },
  });
  expect(addItem.statusCode, `add item: ${addItem.body}`).toBe(201);

  const checkout = await app.inject({
    method: 'POST',
    url: `/v1/carts/${cart.id}/checkout`,
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: {
      deliveryAddressId: ALICE_ADDRESS_ID,
      paymentMethodId: ALICE_PAYMENT_METHOD_ID,
      driverTipCents: tipCents,
    },
  });
  expect(checkout.statusCode, `checkout: ${checkout.body}`).toBe(201);
  return checkout.json<CheckoutBody>();
}

async function fetchPaymentTransactionsForOrder(
  orderId: string,
): Promise<readonly PaymentTransactionRow[]> {
  return getPool().sql.unsafe<PaymentTransactionRow[]>(
    `SELECT id, provider_ref, status, amount_cents, authorized_at, settled_at
       FROM payment_transactions
      WHERE order_id = $1`,
    [orderId],
  );
}

async function fetchLedgerForOrder(orderId: string): Promise<readonly LedgerRow[]> {
  return getPool().sql.unsafe<LedgerRow[]>(
    `SELECT order_id, account_type, account_ref, debit_cents, credit_cents
       FROM ledger_entries
      WHERE order_id = $1`,
    [orderId],
  );
}

async function fetchWebhookEvents(
  eventIds: readonly string[],
): Promise<readonly WebhookEventRow[]> {
  return getPool().sql.unsafe<WebhookEventRow[]>(
    `SELECT event_id, provider, event_type FROM webhook_events_processed WHERE event_id = ANY($1::text[])`,
    [eventIds as string[]],
  );
}
