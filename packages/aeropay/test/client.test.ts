/**
 * AeropayClient — typed method coverage with an in-memory dispatcher.
 *
 * Each method asserts the happy path (request shape, response mapping)
 * plus the major error paths (401 retry → re-auth, 4xx → PaymentError,
 * schema-violating response → ExternalServiceError, malformed-JSON
 * response → ExternalServiceError). Input-validation guards (empty
 * idempotency key, non-positive amount, empty id) each get a focused
 * test so the 422 surface is unambiguous to upstream callers.
 */
import { ExternalServiceError, PaymentError } from '@dankdash/types';
import { describe, expect, it, vi } from 'vitest';
import { AeropayAuth } from '../src/auth.js';
import { AeropayClient } from '../src/client.js';
import { HttpClient, type HttpDispatcher } from '../src/http.js';
import { MemoryTokenCache } from '../src/token-cache.js';

const BASE_URL = 'https://api.aeropay.example';

function makeClient(opts: {
  readonly dispatcher: HttpDispatcher;
  readonly seedTokenCache?: boolean;
}): AeropayClient {
  const cache = new MemoryTokenCache();
  const http = new HttpClient({
    dispatcher: opts.dispatcher,
    retries: 0,
    sleep: () => Promise.resolve(),
  });
  const auth = new AeropayAuth({
    clientId: 'client-test',
    clientSecret: 'shh',
    apiBaseUrl: BASE_URL,
    http,
    cache,
  });
  if (opts.seedTokenCache !== false) {
    void cache.set(
      'aeropay:token:client-test',
      JSON.stringify({ accessToken: 'tok', tokenType: 'Bearer' }),
      3600,
    );
  }
  return new AeropayClient({ apiBaseUrl: `${BASE_URL}/`, http, auth });
}

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<HttpDispatcher>> {
  return { statusCode: status, headers: {}, body: JSON.stringify(body) };
}

const PAYMENT_FIXTURE = {
  id: 'pi_aero_1',
  status: 'initiated' as const,
  amount_cents: 4_500,
  bank_account_id: 'ba_1',
  customer_ref: 'usr_1',
  order_ref: 'ord_1',
  created_at: '2026-02-01T10:00:00.000Z',
};

const PAYOUT_FIXTURE = {
  id: 'po_1',
  status: 'pending' as const,
  amount_cents: 50_000,
  bank_account_id: 'ba_dispensary',
  recipient_ref: 'disp_1',
  period_start: '2026-02-01T00:00:00.000Z',
  period_end: '2026-02-02T00:00:00.000Z',
  created_at: '2026-02-02T08:00:00.000Z',
};

describe('AeropayClient', () => {
  describe('linkBankAccount', () => {
    it('POSTs to /v1/bank_accounts/link_sessions and returns the hosted URL', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(
        jsonResponse({
          id: 'lnk_1',
          hosted_url: 'https://aeropay.example/link/abc',
          expires_at: '2026-02-01T11:00:00.000Z',
        }),
      );
      const client = makeClient({ dispatcher });
      const session = await client.linkBankAccount({
        customerRef: 'usr_1',
        returnUrl: 'https://dankdash/app/aeropay/return',
      });
      expect(session.id).toBe('lnk_1');
      expect(session.hostedUrl).toBe('https://aeropay.example/link/abc');
      expect(session.expiresAt.toISOString()).toBe('2026-02-01T11:00:00.000Z');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${BASE_URL}/v1/bank_accounts/link_sessions`);
      expect(req.headers.Authorization).toBe('Bearer tok');
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(req.body).toBe(
        JSON.stringify({
          customer_ref: 'usr_1',
          return_url: 'https://dankdash/app/aeropay/return',
        }),
      );
    });

    it('raises ExternalServiceError when the response fails schema validation', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse({ foo: 'bar' }));
      const client = makeClient({ dispatcher });
      await expect(
        client.linkBankAccount({ customerRef: 'usr_1', returnUrl: 'https://dankdash/r' }),
      ).rejects.toBeInstanceOf(ExternalServiceError);
    });
  });

  describe('getBankAccount', () => {
    it('GETs by id and returns the normalized account', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(
        jsonResponse({
          id: 'ba_1',
          customer_ref: 'usr_1',
          status: 'linked',
          masked_account_number: '****4321',
          institution_name: 'Test Federal Credit Union',
        }),
      );
      const client = makeClient({ dispatcher });
      const account = await client.getBankAccount('ba_1');
      expect(account).toEqual({
        id: 'ba_1',
        customerRef: 'usr_1',
        status: 'linked',
        maskedAccountNumber: '****4321',
        institutionName: 'Test Federal Credit Union',
      });
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.method).toBe('GET');
      expect(req.url).toBe(`${BASE_URL}/v1/bank_accounts/ba_1`);
      expect(req.body).toBeUndefined();
    });

    it('encodes the id so a path-injection id cannot escape the segment', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(
        jsonResponse({
          id: 'ba/escape',
          customer_ref: 'usr_1',
          status: 'linked',
          masked_account_number: '****0000',
          institution_name: 'X',
        }),
      );
      const client = makeClient({ dispatcher });
      await client.getBankAccount('ba/escape');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.url).toBe(`${BASE_URL}/v1/bank_accounts/ba%2Fescape`);
    });

    it('rejects an empty id with PAYMENT_METHOD_INVALID', async () => {
      const dispatcher = vi.fn<HttpDispatcher>();
      const client = makeClient({ dispatcher });
      await expect(client.getBankAccount('')).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_INVALID',
      });
      expect(dispatcher).not.toHaveBeenCalled();
    });
  });

  describe('createPayment', () => {
    it('POSTs to /v1/payments with an Idempotency-Key and returns the normalized payment', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse(PAYMENT_FIXTURE));
      const client = makeClient({ dispatcher });
      const payment = await client.createPayment({
        bankAccountId: 'ba_1',
        amountCents: 4_500,
        customerRef: 'usr_1',
        orderRef: 'ord_1',
        idempotencyKey: 'idem-xyz',
      });
      expect(payment.id).toBe('pi_aero_1');
      expect(payment.amountCents).toBe(4_500);
      expect(payment.createdAt.toISOString()).toBe('2026-02-01T10:00:00.000Z');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.headers['Idempotency-Key']).toBe('idem-xyz');
      expect(JSON.parse(req.body!)).toEqual({
        bank_account_id: 'ba_1',
        amount_cents: 4_500,
        customer_ref: 'usr_1',
        order_ref: 'ord_1',
      });
    });

    it('rejects an empty idempotency key', async () => {
      const dispatcher = vi.fn<HttpDispatcher>();
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: '',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
      expect(dispatcher).not.toHaveBeenCalled();
    });

    it('rejects a non-positive amount with PAYMENT_AMOUNT_MISMATCH', async () => {
      const dispatcher = vi.fn<HttpDispatcher>();
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 0,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    });

    it('rejects a non-integer amount', async () => {
      const dispatcher = vi.fn<HttpDispatcher>();
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 4500.5,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    });

    it('maps a 422 response to PaymentError PAYMENT_DECLINED', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
        statusCode: 422,
        headers: {},
        body: '{"error":"insufficient_funds"}',
      });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 100,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_DECLINED', statusCode: 402 });
    });

    it('maps a 402 response to PaymentError PAYMENT_DECLINED', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue({ statusCode: 402, headers: {}, body: '{}' });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_DECLINED' });
    });

    it('maps a 404 response to PaymentError PAYMENT_METHOD_INVALID', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue({ statusCode: 404, headers: {}, body: '{}' });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_missing',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID', statusCode: 404 });
    });

    it('maps an unexpected 5xx (post-retry) to PAYMENT_PROVIDER_UNAVAILABLE', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue({ statusCode: 502, headers: {}, body: '' });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', statusCode: 502 });
    });

    it('treats 401 as a credential-rotation signal and retries once after invalidating the token', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        // 1st call: token endpoint returns a fresh token
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ access_token: 'stale', token_type: 'Bearer', expires_in: 3600 }),
        })
        // 2nd call: /v1/payments returns 401 (creds rotated upstream)
        .mockResolvedValueOnce({ statusCode: 401, headers: {}, body: '{}' })
        // 3rd call: token endpoint returns the new token after invalidate()
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 }),
        })
        // 4th call: /v1/payments succeeds with the fresh token
        .mockResolvedValueOnce(jsonResponse(PAYMENT_FIXTURE));
      const client = makeClient({ dispatcher, seedTokenCache: false });
      const payment = await client.createPayment({
        bankAccountId: 'ba_1',
        amountCents: 100,
        customerRef: 'usr_1',
        orderRef: 'ord_1',
        idempotencyKey: 'k',
      });
      expect(payment.id).toBe('pi_aero_1');
      const second = dispatcher.mock.calls[1]!;
      expect(second[0].headers.Authorization).toBe('Bearer stale');
      const fourth = dispatcher.mock.calls[3]!;
      expect(fourth[0].headers.Authorization).toBe('Bearer fresh');
    });

    it('raises PAYMENT_PROVIDER_UNAVAILABLE when the re-auth retry also returns 401', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ access_token: 't1', token_type: 'Bearer', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({ statusCode: 401, headers: {}, body: '{}' })
        .mockResolvedValueOnce({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ access_token: 't2', token_type: 'Bearer', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({ statusCode: 401, headers: {}, body: '{}' });
      const client = makeClient({ dispatcher, seedTokenCache: false });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    });

    it('raises ExternalServiceError when the success body is not JSON', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: 'not-json-at-all',
      });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toBeInstanceOf(ExternalServiceError);
    });

    it('raises ExternalServiceError when the success body fails schema validation', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue(jsonResponse({ id: 'pi_1', status: 'initiated' })); // missing required fields
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toThrow(/schema validation/);
    });

    it('raises PAYMENT_PROVIDER_UNAVAILABLE on a 500 response (covers the default arm)', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue({ statusCode: 599, headers: {}, body: '' });
      const client = makeClient({ dispatcher });
      await expect(
        client.createPayment({
          bankAccountId: 'ba_1',
          amountCents: 1,
          customerRef: 'usr_1',
          orderRef: 'ord_1',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    });
  });

  describe('getPayment', () => {
    it('GETs and returns the normalized payment', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse(PAYMENT_FIXTURE));
      const client = makeClient({ dispatcher });
      const payment = await client.getPayment('pi_aero_1');
      expect(payment.status).toBe('initiated');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.method).toBe('GET');
      expect(req.url).toBe(`${BASE_URL}/v1/payments/pi_aero_1`);
    });

    it('rejects an empty payment id', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(client.getPayment('')).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    });
  });

  describe('cancelPayment', () => {
    it('POSTs to /cancel with a derived idempotency key', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue(jsonResponse({ ...PAYMENT_FIXTURE, status: 'canceled' }));
      const client = makeClient({ dispatcher });
      const payment = await client.cancelPayment('pi_aero_1');
      expect(payment.status).toBe('canceled');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.url).toBe(`${BASE_URL}/v1/payments/pi_aero_1/cancel`);
      expect(req.headers['Idempotency-Key']).toBe('cancel:pi_aero_1');
      expect(req.body).toBe('{}');
    });

    it('rejects an empty payment id', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(client.cancelPayment('')).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_INVALID',
      });
    });
  });

  describe('refundPayment', () => {
    it('POSTs to /refunds with amount, reason, and idempotency key', async () => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValue(jsonResponse({ ...PAYMENT_FIXTURE, status: 'refunded' }));
      const client = makeClient({ dispatcher });
      const payment = await client.refundPayment({
        paymentId: 'pi_aero_1',
        amountCents: 4_500,
        reasonCode: 'customer_request',
        idempotencyKey: 'rfd-1',
      });
      expect(payment.status).toBe('refunded');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.url).toBe(`${BASE_URL}/v1/payments/pi_aero_1/refunds`);
      expect(req.headers['Idempotency-Key']).toBe('rfd-1');
      expect(JSON.parse(req.body!)).toEqual({
        amount_cents: 4_500,
        reason_code: 'customer_request',
      });
    });

    it('rejects an empty idempotency key', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(
        client.refundPayment({
          paymentId: 'pi_aero_1',
          amountCents: 1,
          reasonCode: 'x',
          idempotencyKey: '',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    });

    it('rejects an empty payment id', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(
        client.refundPayment({
          paymentId: '',
          amountCents: 1,
          reasonCode: 'x',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    });

    it('rejects a zero amount with PAYMENT_AMOUNT_MISMATCH', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(
        client.refundPayment({
          paymentId: 'pi_aero_1',
          amountCents: 0,
          reasonCode: 'x',
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    });
  });

  describe('createPayout', () => {
    it('POSTs to /v1/payouts with period bounds and returns the normalized payout', async () => {
      const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse(PAYOUT_FIXTURE));
      const client = makeClient({ dispatcher });
      const periodStart = new Date('2026-02-01T00:00:00.000Z');
      const periodEnd = new Date('2026-02-02T00:00:00.000Z');
      const payout = await client.createPayout({
        bankAccountId: 'ba_dispensary',
        amountCents: 50_000,
        recipientRef: 'disp_1',
        periodStart,
        periodEnd,
        idempotencyKey: 'payout-2026-02-01',
      });
      expect(payout.id).toBe('po_1');
      expect(payout.amountCents).toBe(50_000);
      expect(payout.periodStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(payout.periodEnd.toISOString()).toBe('2026-02-02T00:00:00.000Z');
      expect(payout.createdAt.toISOString()).toBe('2026-02-02T08:00:00.000Z');
      const [req] = dispatcher.mock.calls[0]!;
      expect(req.url).toBe(`${BASE_URL}/v1/payouts`);
      expect(req.headers['Idempotency-Key']).toBe('payout-2026-02-01');
      expect(JSON.parse(req.body!)).toEqual({
        bank_account_id: 'ba_dispensary',
        amount_cents: 50_000,
        recipient_ref: 'disp_1',
        period_start: '2026-02-01T00:00:00.000Z',
        period_end: '2026-02-02T00:00:00.000Z',
      });
    });

    it('rejects an empty idempotency key', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(
        client.createPayout({
          bankAccountId: 'ba_1',
          amountCents: 1,
          recipientRef: 'r',
          periodStart: new Date(0),
          periodEnd: new Date(1),
          idempotencyKey: '',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' });
    });

    it('rejects a negative amount', async () => {
      const client = makeClient({ dispatcher: vi.fn<HttpDispatcher>() });
      await expect(
        client.createPayout({
          bankAccountId: 'ba_1',
          amountCents: -100,
          recipientRef: 'r',
          periodStart: new Date(0),
          periodEnd: new Date(1),
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    });
  });

  it('strips trailing slashes from the configured base URL', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse(PAYMENT_FIXTURE));
    const client = makeClient({ dispatcher });
    await client.getPayment('pi_aero_1');
    const [req] = dispatcher.mock.calls[0]!;
    // The base URL was configured as `${BASE_URL}/` — we should see no
    // double slash before /v1/.
    expect(req.url).toBe(`${BASE_URL}/v1/payments/pi_aero_1`);
  });

  it('does not send a Content-Type or body header on a GET request', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(jsonResponse(PAYMENT_FIXTURE));
    const client = makeClient({ dispatcher });
    await client.getPayment('pi_aero_1');
    const [req] = dispatcher.mock.calls[0]!;
    expect(req.body).toBeUndefined();
    expect(req.headers['Content-Type']).toBeUndefined();
  });

  it('raises ExternalServiceError when a non-JSON body is returned for getPayment', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValue({ statusCode: 200, headers: {}, body: 'oops' });
    const client = makeClient({ dispatcher });
    await expect(client.getPayment('pi_aero_1')).rejects.toThrow(/not valid JSON/);
  });

  it('surfaces PaymentError without details on body when the response body is empty', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValue({ statusCode: 422, headers: {}, body: '' });
    const client = makeClient({ dispatcher });
    await expect(client.getPayment('pi_aero_1')).rejects.toBeInstanceOf(PaymentError);
  });
});
