/**
 * Typed Aeropay REST client.
 *
 * Composes {@link AeropayAuth} for OAuth client credentials and {@link
 * HttpClient} for the underlying transport. Each public method:
 *
 *   1. Acquires the bearer header from auth (cached per-process).
 *   2. Issues the HTTP request with explicit `Idempotency-Key` for POSTs
 *      that create or mutate state.
 *   3. On 200/201, parses through the matching Zod schema and converts
 *      to the public domain type (snake → camel + cents normalization).
 *   4. On 401, invalidates the cached token and retries once — this
 *      recovers from a credential rotation without paging.
 *   5. On any other non-2xx, raises `PaymentError` with a structured
 *      code so the API filter renders a 4xx/5xx with a stable code that
 *      ops can alert on.
 *
 * The class deliberately does not implement Aeropay's full API surface —
 * only the six methods the platform actually uses. Adding more is cheap
 * (each is ~30 lines) but every extra method is a maintenance surface and
 * a coverage liability. Add when needed, not speculatively.
 */
import { ExternalServiceError, PaymentError } from '@dankdash/types';
import { type AeropayAuth } from './auth.js';
import { type HttpClient, type HttpMethod, type HttpResponse } from './http.js';
import {
  BankAccountResponseSchema,
  LinkSessionResponseSchema,
  PaymentResponseSchema,
  PayoutResponseSchema,
} from './schemas.js';
import {
  type AeropayBankAccount,
  type AeropayLinkSession,
  type AeropayPayment,
  type AeropayPayout,
  type CreatePaymentInput,
  type CreatePayoutInput,
  type LinkBankAccountInput,
  type RefundPaymentInput,
} from './types.js';
import type { z } from 'zod';

const SERVICE = 'aeropay';

export interface AeropayClientConfig {
  readonly apiBaseUrl: string;
  readonly http: HttpClient;
  readonly auth: AeropayAuth;
}

export class AeropayClient {
  private readonly apiBaseUrl: string;
  private readonly http: HttpClient;
  private readonly auth: AeropayAuth;

  constructor(config: AeropayClientConfig) {
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.http = config.http;
    this.auth = config.auth;
  }

  async linkBankAccount(input: LinkBankAccountInput): Promise<AeropayLinkSession> {
    const json = await this.request({
      method: 'POST',
      path: '/v1/bank_accounts/link_sessions',
      body: { customer_ref: input.customerRef, return_url: input.returnUrl },
    });
    const parsed = parseOrThrow(LinkSessionResponseSchema, json, '/v1/bank_accounts/link_sessions');
    return {
      id: parsed.id,
      hostedUrl: parsed.hosted_url,
      expiresAt: new Date(parsed.expires_at),
    };
  }

  async getBankAccount(id: string): Promise<AeropayBankAccount> {
    assertNonEmpty(id, 'bankAccountId');
    const json = await this.request({
      method: 'GET',
      path: `/v1/bank_accounts/${encodeURIComponent(id)}`,
    });
    const parsed = parseOrThrow(BankAccountResponseSchema, json, '/v1/bank_accounts/:id');
    return {
      id: parsed.id,
      customerRef: parsed.customer_ref,
      status: parsed.status,
      maskedAccountNumber: parsed.masked_account_number,
      institutionName: parsed.institution_name,
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<AeropayPayment> {
    assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
    assertPositiveAmount(input.amountCents);
    const json = await this.request({
      method: 'POST',
      path: '/v1/payments',
      idempotencyKey: input.idempotencyKey,
      body: {
        bank_account_id: input.bankAccountId,
        amount_cents: input.amountCents,
        customer_ref: input.customerRef,
        order_ref: input.orderRef,
      },
    });
    return toPayment(parseOrThrow(PaymentResponseSchema, json, '/v1/payments'));
  }

  async getPayment(id: string): Promise<AeropayPayment> {
    assertNonEmpty(id, 'paymentId');
    const json = await this.request({
      method: 'GET',
      path: `/v1/payments/${encodeURIComponent(id)}`,
    });
    return toPayment(parseOrThrow(PaymentResponseSchema, json, '/v1/payments/:id'));
  }

  async cancelPayment(id: string): Promise<AeropayPayment> {
    assertNonEmpty(id, 'paymentId');
    const json = await this.request({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(id)}/cancel`,
      // Cancel is idempotent server-side (canceling an already-canceled
      // payment is a no-op) but we still send a key so a network retry
      // doesn't risk a "already canceled" PaymentError surfacing to the
      // caller as a transient failure.
      idempotencyKey: `cancel:${id}`,
      body: {},
    });
    return toPayment(parseOrThrow(PaymentResponseSchema, json, '/v1/payments/:id/cancel'));
  }

  async refundPayment(input: RefundPaymentInput): Promise<AeropayPayment> {
    assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
    assertNonEmpty(input.paymentId, 'paymentId');
    assertPositiveAmount(input.amountCents);
    const json = await this.request({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(input.paymentId)}/refunds`,
      idempotencyKey: input.idempotencyKey,
      body: {
        amount_cents: input.amountCents,
        reason_code: input.reasonCode,
      },
    });
    return toPayment(parseOrThrow(PaymentResponseSchema, json, '/v1/payments/:id/refunds'));
  }

  async createPayout(input: CreatePayoutInput): Promise<AeropayPayout> {
    assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
    assertPositiveAmount(input.amountCents);
    const json = await this.request({
      method: 'POST',
      path: '/v1/payouts',
      idempotencyKey: input.idempotencyKey,
      body: {
        bank_account_id: input.bankAccountId,
        amount_cents: input.amountCents,
        recipient_ref: input.recipientRef,
        period_start: input.periodStart.toISOString(),
        period_end: input.periodEnd.toISOString(),
      },
    });
    return toPayout(parseOrThrow(PayoutResponseSchema, json, '/v1/payouts'));
  }

  /**
   * Read a payout's current state by its upstream id. Used by the
   * settlement-reconciliation worker to resolve `payouts` rows stranded in
   * `processing` when the terminal webhook (`payout.paid`/`payout.failed`)
   * was never delivered. A GET carries no idempotency concern.
   */
  async getPayout(id: string): Promise<AeropayPayout> {
    assertNonEmpty(id, 'payoutId');
    const json = await this.request({
      method: 'GET',
      path: `/v1/payouts/${encodeURIComponent(id)}`,
    });
    return toPayout(parseOrThrow(PayoutResponseSchema, json, '/v1/payouts/:id'));
  }

  private async request(opts: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly body?: Readonly<Record<string, unknown>>;
    readonly idempotencyKey?: string;
  }): Promise<unknown> {
    const url = `${this.apiBaseUrl}${opts.path}`;
    const baseHeaders: Record<string, string> = {
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      baseHeaders['Content-Type'] = 'application/json';
    }
    if (opts.idempotencyKey !== undefined) {
      baseHeaders['Idempotency-Key'] = opts.idempotencyKey;
    }

    const send = async (): Promise<HttpResponse> => {
      const authHeader = await this.auth.getAuthorizationHeader();
      const headers = { ...baseHeaders, Authorization: authHeader };
      if (opts.body === undefined) {
        return this.http.send({ method: opts.method, url, headers });
      }
      return this.http.send({
        method: opts.method,
        url,
        headers,
        body: JSON.stringify(opts.body),
      });
    };

    let resp = await send();
    if (resp.statusCode === 401) {
      // Token rotated upstream or revoked mid-TTL. Drop the cache and
      // retry once — if the second attempt also 401s, surface as a
      // provider-credentials failure so ops can investigate.
      await this.auth.invalidate();
      resp = await send();
    }

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return parseJsonOrThrow(resp.body, opts.path);
    }

    throw mapErrorResponse(opts.method, opts.path, resp);
  }
}

function toPayment(parsed: z.infer<typeof PaymentResponseSchema>): AeropayPayment {
  return {
    id: parsed.id,
    status: parsed.status,
    amountCents: parsed.amount_cents,
    bankAccountId: parsed.bank_account_id,
    customerRef: parsed.customer_ref,
    orderRef: parsed.order_ref,
    createdAt: new Date(parsed.created_at),
  };
}

function toPayout(parsed: z.infer<typeof PayoutResponseSchema>): AeropayPayout {
  return {
    id: parsed.id,
    status: parsed.status,
    amountCents: parsed.amount_cents,
    bankAccountId: parsed.bank_account_id,
    recipientRef: parsed.recipient_ref,
    periodStart: new Date(parsed.period_start),
    periodEnd: new Date(parsed.period_end),
    createdAt: new Date(parsed.created_at),
  };
}

function parseJsonOrThrow(body: string, path: string): unknown {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new ExternalServiceError(
      SERVICE,
      `response body for ${path} was not valid JSON`,
      { bodyPreview: body.slice(0, 256) },
      err,
    );
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, json: unknown, path: string): T {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ExternalServiceError(SERVICE, `response for ${path} failed schema validation`, {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return result.data;
}

function mapErrorResponse(method: HttpMethod, path: string, resp: HttpResponse): PaymentError {
  const preview = resp.body.slice(0, 512);
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    return new PaymentError(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Aeropay rejected our credentials',
      { method, path, status: resp.statusCode, bodyPreview: preview },
      502,
    );
  }
  if (resp.statusCode === 402 || resp.statusCode === 422) {
    return new PaymentError(
      'PAYMENT_DECLINED',
      'Aeropay rejected the payment request',
      { method, path, status: resp.statusCode, bodyPreview: preview },
      402,
    );
  }
  if (resp.statusCode === 404) {
    return new PaymentError(
      'PAYMENT_METHOD_INVALID',
      'Aeropay resource not found',
      { method, path, status: resp.statusCode, bodyPreview: preview },
      404,
    );
  }
  return new PaymentError(
    'PAYMENT_PROVIDER_UNAVAILABLE',
    'Aeropay returned an unexpected status',
    { method, path, status: resp.statusCode, bodyPreview: preview },
    502,
  );
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new PaymentError(
      'PAYMENT_METHOD_INVALID',
      `${field} must be a non-empty string`,
      { field },
      422,
    );
  }
}

function assertPositiveAmount(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PaymentError(
      'PAYMENT_AMOUNT_MISMATCH',
      'amountCents must be a positive integer',
      { amountCents: value },
      422,
    );
  }
}
