/**
 * Typed Metrc REST client.
 *
 * Composes {@link HttpClient} for transport and {@link buildBasicAuthHeader}
 * for per-request credentials. Each public method:
 *
 *   1. Builds the URL with the per-facility `licenseNumber` query param.
 *   2. Builds the Basic-auth header from the constant vendor key + the
 *      per-facility user key supplied at the call site.
 *   3. Sends the request through HttpClient (which handles retries on
 *      idempotent verbs and 5xx-ish statuses).
 *   4. On 2xx, parses the body through the matching Zod schema and
 *      converts the upstream PascalCase shape to the public camelCase
 *      domain type.
 *   5. On any non-2xx, raises `ExternalServiceError('metrc', ...)` with
 *      a structured payload preview the worker can log and triage
 *      against. 401/403/404 carry their original status so the worker
 *      knows the difference between "credentials wrong" and "Metrc is
 *      having a bad day".
 *
 * Why we do *not* implement an in-process token cache the way Aeropay
 * does: Metrc uses HTTP Basic auth with two long-lived keys and no
 * refresh/expiry semantics. Every request just rebuilds the header from
 * the two keys — there's nothing to cache.
 *
 * Idempotency: Metrc itself does not honor an `Idempotency-Key` header.
 * We get dedup for `createReceipt` via DB-level uniqueness on
 * `metrc_transactions.order_id` (the worker only ever schedules one
 * receipt per order). The HTTP layer is therefore configured to NOT
 * retry POSTs — a network flake mid-POST might leave us uncertain
 * whether the receipt landed, and the safe move is to fail loudly and
 * let the reconciliation cron resolve the truth from `/receipts/active`.
 */
import { ExternalServiceError } from '@dankdash/types';
import { buildBasicAuthHeader } from './auth.js';
import { type HttpClient, type HttpMethod, type HttpResponse } from './http.js';
import {
  ReceiptListResponseSchema,
  ReceiptResponseSchema,
  type ReceiptResponse,
} from './schemas.js';
import {
  type CreateReceiptInput,
  type CreateReceiptOutcome,
  type GetReceiptInput,
  type ListActiveReceiptsInput,
  type MetrcReceipt,
  type MetrcReceiptTransaction,
} from './types.js';
import type { z } from 'zod';

const SERVICE = 'metrc';

export interface MetrcClientConfig {
  /** e.g. `https://api-mn.metrc.com` — no trailing slash required. */
  readonly apiBaseUrl: string;
  /** Vendor API key, scoped to the integration partner (us). */
  readonly vendorKey: string;
  readonly http: HttpClient;
  /**
   * Clock injector — defaults to `() => new Date()` in production.
   * Tests pin it so `acceptedAt` is deterministic without faking
   * globals.
   */
  readonly clock?: () => Date;
}

export class MetrcClient {
  private readonly apiBaseUrl: string;
  private readonly vendorKey: string;
  private readonly http: HttpClient;
  private readonly clock: () => Date;

  constructor(config: MetrcClientConfig) {
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.vendorKey = config.vendorKey;
    this.http = config.http;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  /**
   * POST a sales receipt for one order.
   *
   * Metrc's POST endpoints accept an array of receipts and return 200
   * with an empty body on success. We always send a single-element
   * array — batching multiple orders into one POST would couple their
   * fate (one bad transaction line fails the whole batch) and tangle
   * the per-order retry semantics the worker depends on. The marginal
   * latency saving isn't worth the operational tax.
   */
  async createReceipt(input: CreateReceiptInput): Promise<CreateReceiptOutcome> {
    assertNonEmpty(input.licenseNumber, 'licenseNumber');
    assertNonEmpty(input.userKey, 'userKey');
    assertTransactionsPresent(input.transactions);

    const body: ReadonlyArray<Record<string, unknown>> = [
      {
        SalesDateTime: input.salesDateTime.toISOString(),
        SalesCustomerType: input.salesCustomerType,
        ...(input.patientLicenseNumber !== undefined
          ? { PatientLicenseNumber: input.patientLicenseNumber }
          : {}),
        Transactions: input.transactions.map((line) => ({
          PackageLabel: line.packageLabel,
          Quantity: line.quantity,
          UnitOfMeasure: line.unitOfMeasure,
          TotalAmount: centsToDollars(line.totalAmountCents),
        })),
      },
    ];

    await this.request({
      method: 'POST',
      path: '/sales/v2/receipts',
      licenseNumber: input.licenseNumber,
      userKey: input.userKey,
      body,
    });

    // Metrc returns 200 with an empty body; surface the local clock so
    // the worker can persist a deterministic `reported_at` and the
    // reconciliation cron has a tight window to scan.
    return { acceptedAt: this.clock() };
  }

  /**
   * Page-free listing of receipts modified in a window. Metrc's
   * `/receipts/active` returns a JSON array (no cursor) — at our volume
   * (single dispensary daily) the response is bounded by the day's order
   * count, which is well within the 1 MiB body cap enforced by the
   * dispatcher.
   */
  async listActiveReceipts(input: ListActiveReceiptsInput): Promise<MetrcReceipt[]> {
    assertNonEmpty(input.licenseNumber, 'licenseNumber');
    assertNonEmpty(input.userKey, 'userKey');
    if (input.lastModifiedEnd.getTime() <= input.lastModifiedStart.getTime()) {
      throw new ExternalServiceError(
        SERVICE,
        'lastModifiedEnd must be strictly after lastModifiedStart',
        {
          start: input.lastModifiedStart.toISOString(),
          end: input.lastModifiedEnd.toISOString(),
        },
      );
    }

    const query = new URLSearchParams({
      lastModifiedStart: input.lastModifiedStart.toISOString(),
      lastModifiedEnd: input.lastModifiedEnd.toISOString(),
    });
    const json = await this.request({
      method: 'GET',
      path: `/sales/v2/receipts/active?${query.toString()}`,
      licenseNumber: input.licenseNumber,
      userKey: input.userKey,
    });
    const parsed = parseOrThrow(ReceiptListResponseSchema, json, '/sales/v2/receipts/active');
    return parsed.map(toReceipt);
  }

  async getReceipt(input: GetReceiptInput): Promise<MetrcReceipt> {
    assertNonEmpty(input.licenseNumber, 'licenseNumber');
    assertNonEmpty(input.userKey, 'userKey');
    if (!Number.isInteger(input.id) || input.id < 1) {
      throw new ExternalServiceError(SERVICE, 'receipt id must be a positive integer', {
        id: input.id,
      });
    }
    const json = await this.request({
      method: 'GET',
      path: `/sales/v2/receipts/${String(input.id)}`,
      licenseNumber: input.licenseNumber,
      userKey: input.userKey,
    });
    return toReceipt(parseOrThrow(ReceiptResponseSchema, json, '/sales/v2/receipts/:id'));
  }

  private async request(opts: {
    readonly method: HttpMethod;
    /** Path possibly already containing a `?...` query string. */
    readonly path: string;
    readonly licenseNumber: string;
    readonly userKey: string;
    readonly body?: unknown;
  }): Promise<unknown> {
    const sep = opts.path.includes('?') ? '&' : '?';
    const url = `${this.apiBaseUrl}${opts.path}${sep}licenseNumber=${encodeURIComponent(opts.licenseNumber)}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: buildBasicAuthHeader(this.vendorKey, opts.userKey),
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const resp =
      opts.body === undefined
        ? await this.http.send({ method: opts.method, url, headers })
        : await this.http.send({
            method: opts.method,
            url,
            headers,
            body: JSON.stringify(opts.body),
          });

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      // Metrc's create endpoints return 200 with an empty body — guard
      // against that before handing to JSON.parse so the caller doesn't
      // get a spurious `Unexpected end of JSON input` masking the
      // success.
      if (resp.body.trim().length === 0) return null;
      return parseJsonOrThrow(resp.body, opts.path);
    }

    throw mapErrorResponse(opts.method, opts.path, resp);
  }
}

function toReceipt(parsed: ReceiptResponse): MetrcReceipt {
  return {
    id: parsed.Id,
    receiptNumber: parsed.ReceiptNumber,
    salesDateTime: new Date(parsed.SalesDateTime),
    salesCustomerType: parsed.SalesCustomerType,
    totalPackages: parsed.TotalPackages,
    totalPrice: parsed.TotalPrice,
    transactions: parsed.Transactions.map(toReceiptTransaction),
    lastModified: new Date(parsed.LastModified),
  };
}

function toReceiptTransaction(t: ReceiptResponse['Transactions'][number]): MetrcReceiptTransaction {
  return {
    packageId: t.PackageId,
    packageLabel: t.PackageLabel,
    productName: t.ProductName,
    quantity: t.Quantity,
    unitOfMeasure: t.UnitOfMeasure,
    totalPrice: t.TotalPrice,
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

/**
 * Generic is split across `Output, Def, unknown` so TS infers from the
 * schema's *output* shape rather than collapsing input/output. The naive
 * `z.ZodType<T>` form (T defaults to both input AND output) trips on
 * schemas that compose `.transform(...)` with `.passthrough()` — the
 * caller ends up with `TotalPrice: string | number` instead of the
 * transformed `string`. Pinning the third generic to `unknown` keeps the
 * input wide while letting the output flow through.
 */
function parseOrThrow<TOut>(
  schema: z.ZodType<TOut, z.ZodTypeDef, unknown>,
  json: unknown,
  path: string,
): TOut {
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

function mapErrorResponse(
  method: HttpMethod,
  path: string,
  resp: HttpResponse,
): ExternalServiceError {
  const preview = resp.body.slice(0, 512);
  return new ExternalServiceError(SERVICE, `Metrc returned status ${String(resp.statusCode)}`, {
    method,
    path,
    status: resp.statusCode,
    bodyPreview: preview,
  });
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new ExternalServiceError(SERVICE, `${field} must be a non-empty string`, { field });
  }
}

function assertTransactionsPresent(
  transactions: ReadonlyArray<unknown> | undefined,
): asserts transactions is ReadonlyArray<unknown> {
  if (transactions === undefined || transactions.length === 0) {
    throw new ExternalServiceError(SERVICE, 'createReceipt requires at least one transaction', {
      transactionCount: transactions?.length ?? 0,
    });
  }
}

/**
 * Convert integer cents to a dollar-precision string Metrc accepts.
 * We deliberately format with toFixed(2) — Metrc emits numbers in the
 * receipt response but accepts numbers or strings on input; the string
 * form rules out a `999.999999` from a careless float.
 */
function centsToDollars(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new ExternalServiceError(SERVICE, 'totalAmountCents must be a non-negative integer', {
      cents,
    });
  }
  return (cents / 100).toFixed(2);
}
