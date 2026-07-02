/**
 * Dispensary payout bank-linking + payout-completion webhooks against the
 * real NestJS DI graph, real Postgres, and the real HMAC verifier.
 *
 * Two surfaces exercised end-to-end:
 *
 *   A. Vendor bank linking — `GET /v1/vendor/payouts/bank-account` (status)
 *      and `POST .../bank-account/link` (start hosted session), plus the
 *      `bank_account.linked` webhook that persists `aeropay_account_ref`
 *      onto the dispensary. The customer_ref is asserted to carry the
 *      `dispensary:<id>` namespace so it can never collide with a consumer
 *      link. Role gate: budtenders are 403.
 *
 *   B. Payout completion — a `processing` payouts row (as the nightly job
 *      would leave it) is flipped to `completed` by `payout.paid` and to
 *      `failed` by `payout.failed`; an unknown ref is a benign no-op and a
 *      replayed event is deduped to 204 with no state change.
 *
 * Outbound Aeropay HTTP is stubbed via the FakeAeropayClient override on
 * AEROPAY_CLIENT so the suite stays hermetic. Payloads are signed with the
 * test webhook secret so the real AeropayWebhookVerifier runs in-band.
 */
import { createHmac } from 'node:crypto';
import { type AeropayBankAccount, type AeropayLinkSession } from '@dankdash/aeropay';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../../src/modules/payments/tokens.js';
import { buildTestApp } from '../helpers/build-app.js';
import { SEED_IDS, bearer, getPool, resetRateLimit, seedFixtures, signTokenFor } from './setup.js';

const WEBHOOK_SECRET = 'test';
const MPLS = SEED_IDS.dispensary.mpls;

interface StatusBody {
  readonly linked: boolean;
}
interface StartBody {
  readonly link: { readonly id: string; readonly hostedUrl: string; readonly expiresAt: string };
}
interface PayoutRow {
  readonly status: string;
  // postgres.js returns timestamptz as a string from `.unsafe` queries.
  readonly completed_at: string | null;
  readonly failure_reason: string | null;
}

class FakeAeropayClient implements AeropayClientLike {
  linkCalls: Array<{ customerRef: string; returnUrl: string }> = [];
  bankAccountsById = new Map<string, AeropayBankAccount>();
  nextLinkSession: AeropayLinkSession = {
    id: 'link_session_int_1',
    hostedUrl: 'https://link.aeropay.com/session/int_1',
    expiresAt: new Date('2026-06-01T03:00:00.000Z'),
  };

  linkBankAccount = (input: {
    customerRef: string;
    returnUrl: string;
  }): Promise<AeropayLinkSession> => {
    this.linkCalls.push(input);
    return Promise.resolve(this.nextLinkSession);
  };

  getBankAccount = (id: string): Promise<AeropayBankAccount> => {
    const account = this.bankAccountsById.get(id);
    if (account === undefined) return Promise.reject(new Error(`unexpected getBankAccount: ${id}`));
    return Promise.resolve(account);
  };

  createPayment = (): Promise<never> => Promise.reject(new Error('not used in payouts flow'));
  getPayment = (): Promise<never> => Promise.reject(new Error('not used in payouts flow'));
  cancelPayment = (): Promise<never> => Promise.reject(new Error('not used in payouts flow'));
  refundPayment = (): Promise<never> => Promise.reject(new Error('not used in payouts flow'));
  createPayout = (): Promise<never> => Promise.reject(new Error('not used in payouts flow'));
}

function signWebhook(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function envelope(input: {
  eventId: string;
  type: string;
  objectId: string;
  extraObject?: Readonly<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    id: input.eventId,
    type: input.type,
    created_at: new Date().toISOString(),
    data: { object: { id: input.objectId, ...(input.extraObject ?? {}) } },
  });
}

async function postWebhook(app: NestFastifyApplication, body: string): Promise<number> {
  const resp = await app.inject({
    method: 'POST',
    url: '/v1/payment-methods/aeropay/webhook',
    headers: { 'content-type': 'application/json', 'aeropay-signature': signWebhook(body) },
    payload: body,
  });
  return resp.statusCode;
}

async function insertProcessingPayout(aeropayPayoutRef: string): Promise<void> {
  // Insert exactly what the nightly job leaves after a successful dispatch:
  // a `processing` row stamped with the upstream payout ref. Raw SQL runs as
  // the app owner role, which is not `app_vendor`, so the RLS policy (scoped
  // to that role) does not apply — same posture as the workers payout job.
  await getPool().sql.unsafe(
    `INSERT INTO payouts
       (recipient_type, recipient_id, period_start, period_end, gross_cents,
        fees_cents, net_cents, aeropay_payout_ref, status, scheduled_for, initiated_at)
     VALUES ('dispensary', $1, '2026-05-04', '2026-05-05', 12500, 0, 12500, $2,
             'processing', '2026-05-05', now())`,
    [MPLS, aeropayPayoutRef],
  );
}

async function fetchPayoutByRef(aeropayPayoutRef: string): Promise<PayoutRow | undefined> {
  const rows = await getPool().sql.unsafe<PayoutRow[]>(
    `SELECT status, completed_at, failure_reason FROM payouts WHERE aeropay_payout_ref = $1`,
    [aeropayPayoutRef],
  );
  return rows[0];
}

async function fetchDispensaryBankRef(): Promise<string | null> {
  const rows = await getPool().sql.unsafe<Array<{ aeropay_account_ref: string | null }>>(
    `SELECT aeropay_account_ref FROM dispensaries WHERE id = $1`,
    [MPLS],
  );
  return rows[0]?.aeropay_account_ref ?? null;
}

describe('dispensary payouts — bank linking + completion webhooks', () => {
  let app: NestFastifyApplication;
  let aeropay: FakeAeropayClient;

  beforeAll(async () => {
    aeropay = new FakeAeropayClient();
    app = await buildTestApp({ overrides: [{ token: AEROPAY_CLIENT, value: aeropay }] });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedFixtures();
    resetRateLimit(app);
    aeropay.linkCalls.length = 0;
    aeropay.bankAccountsById.clear();
  });

  it('links a dispensary bank account end-to-end: status → start → webhook → status', async () => {
    const ownerToken = signTokenFor(app, { userId: SEED_IDS.user.mplsOwner, role: 'owner' });
    const headers = {
      ...bearer(ownerToken),
      'x-dispensary-id': MPLS,
      'content-type': 'application/json',
    };

    // Seed starts unlinked.
    const before = await app.inject({
      method: 'GET',
      url: '/v1/vendor/payouts/bank-account',
      headers,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json<StatusBody>().linked).toBe(false);

    // Start a hosted session — customer_ref must be dispensary-namespaced.
    const start = await app.inject({
      method: 'POST',
      url: '/v1/vendor/payouts/bank-account/link',
      headers,
      payload: { returnUrl: 'https://portal.dankdash.com/payouts' },
    });
    expect(start.statusCode, start.body).toBe(201);
    expect(start.json<StartBody>().link.hostedUrl).toBe('https://link.aeropay.com/session/int_1');
    expect(aeropay.linkCalls).toEqual([
      { customerRef: `dispensary:${MPLS}`, returnUrl: 'https://portal.dankdash.com/payouts' },
    ]);

    // Aeropay confirms the link via webhook; getBankAccount echoes the ns ref.
    aeropay.bankAccountsById.set('ba_int_1', {
      id: 'ba_int_1',
      customerRef: `dispensary:${MPLS}`,
      status: 'linked',
      maskedAccountNumber: '******9911',
      institutionName: 'Test CU',
    });
    const hook = envelope({
      eventId: 'evt_disp_link_1',
      type: 'bank_account.linked',
      objectId: 'ba_int_1',
    });
    expect(await postWebhook(app, hook)).toBe(204);
    expect(await fetchDispensaryBankRef()).toBe('ba_int_1');

    // Status now reports linked.
    const after = await app.inject({
      method: 'GET',
      url: '/v1/vendor/payouts/bank-account',
      headers,
    });
    expect(after.json<StatusBody>().linked).toBe(true);
  });

  it('rejects a budtender from the bank-account surface (role gate)', async () => {
    const budtenderToken = signTokenFor(app, {
      userId: SEED_IDS.user.mplsBudtender,
      role: 'budtender',
    });
    const resp = await app.inject({
      method: 'GET',
      url: '/v1/vendor/payouts/bank-account',
      headers: { ...bearer(budtenderToken), 'x-dispensary-id': MPLS },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('completes a processing payout on payout.paid', async () => {
    await insertProcessingPayout('po_int_paid_1');

    const body = envelope({
      eventId: 'evt_payout_paid_1',
      type: 'payout.paid',
      objectId: 'po_int_paid_1',
    });
    expect(await postWebhook(app, body)).toBe(204);

    const row = await fetchPayoutByRef('po_int_paid_1');
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).not.toBeNull();
  });

  it('fails a processing payout on payout.failed with the upstream reason', async () => {
    await insertProcessingPayout('po_int_failed_1');

    const body = envelope({
      eventId: 'evt_payout_failed_1',
      type: 'payout.failed',
      objectId: 'po_int_failed_1',
      extraObject: { failure_reason: 'bank_account_closed' },
    });
    expect(await postWebhook(app, body)).toBe(204);

    const row = await fetchPayoutByRef('po_int_failed_1');
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('bank_account_closed');
  });

  it('is a benign no-op for payout.paid against an unknown ref', async () => {
    const body = envelope({
      eventId: 'evt_payout_unknown_1',
      type: 'payout.paid',
      objectId: 'po_nonexistent',
    });
    expect(await postWebhook(app, body)).toBe(204);
    expect(await fetchPayoutByRef('po_nonexistent')).toBeUndefined();
  });

  it('dedupes a replayed payout.paid and does not regress the row', async () => {
    await insertProcessingPayout('po_int_replay_1');
    const body = envelope({
      eventId: 'evt_payout_replay_1',
      type: 'payout.paid',
      objectId: 'po_int_replay_1',
    });

    expect(await postWebhook(app, body)).toBe(204);
    const first = await fetchPayoutByRef('po_int_replay_1');
    expect(first?.status).toBe('completed');

    // Same event id — webhook_events_processed short-circuits to 204.
    expect(await postWebhook(app, body)).toBe(204);
    const second = await fetchPayoutByRef('po_int_replay_1');
    expect(second?.status).toBe('completed');
    expect(second?.completed_at).toEqual(first?.completed_at);
  });
});
