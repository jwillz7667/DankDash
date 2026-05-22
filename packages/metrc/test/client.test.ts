/**
 * MetrcClient unit coverage. Every test drives the transport through a
 * fake HttpDispatcher so we can assert exactly what bytes go on the wire
 * (URL, headers, body) without spinning up a real HTTP server.
 *
 * The interesting properties to verify here aren't "did we call HTTP" —
 * they're:
 *
 *   - Basic auth header is built from the vendor + user keys for *every*
 *     request, even repeated calls (no static caching that could leak a
 *     stale userKey between dispensaries).
 *   - licenseNumber rides on every URL as a query parameter — Metrc's
 *     API rejects requests without it.
 *   - Create-receipt POST body matches Metrc's documented shape
 *     (PascalCase, ISO timestamp, dollar-precision string for amounts).
 *   - The schema layer rejects malformed responses with a Zod-style
 *     validation error wrapped in ExternalServiceError, not a TypeError.
 *   - Empty bodies on 2xx responses (Metrc's create endpoint behavior)
 *     resolve cleanly rather than crashing on JSON.parse.
 */
import { ExternalServiceError } from '@dankdash/types';
import { describe, expect, it, vi } from 'vitest';
import { MetrcClient } from '../src/client.js';
import { HttpClient, type HttpDispatcher, type HttpResponse } from '../src/http.js';

const VENDOR = 'vendor-key';
const USER = 'user-key';
const LICENSE = 'MN-LIC-001';
const FIXED_NOW = new Date('2026-05-19T15:00:00.000Z');

function ok(body: unknown): HttpResponse {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function failResp(statusCode: number, body = ''): HttpResponse {
  return { statusCode, headers: {}, body };
}

function buildClient(
  dispatcher: HttpDispatcher,
  overrides: { readonly clock?: () => Date } = {},
): MetrcClient {
  const http = new HttpClient({ dispatcher, retries: 0, sleep: () => Promise.resolve() });
  return new MetrcClient({
    apiBaseUrl: 'https://api-mn.metrc.com/',
    vendorKey: VENDOR,
    http,
    clock: overrides.clock ?? ((): Date => FIXED_NOW),
  });
}

const RECEIPT_FIXTURE = {
  Id: 42,
  ReceiptNumber: 'RCP-0042',
  SalesDateTime: '2026-05-19T14:55:00Z',
  SalesCustomerType: 'Consumer',
  TotalPackages: 1,
  TotalPrice: '12.50',
  Transactions: [
    {
      PackageId: 100,
      PackageLabel: '1A4FF01000000220000123',
      ProductName: 'Blue Dream 1g',
      Quantity: '1',
      UnitOfMeasure: 'Grams',
      TotalPrice: 12.5,
    },
  ],
  LastModified: '2026-05-19T14:55:10Z',
};

describe('MetrcClient.createReceipt', () => {
  it('POSTs a single-element array to /sales/v2/receipts with licenseNumber', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    const outcome = await client.createReceipt({
      salesDateTime: new Date('2026-05-19T14:55:00Z'),
      salesCustomerType: 'Consumer',
      transactions: [
        {
          packageLabel: '1A4FF01000000220000123',
          quantity: '1',
          unitOfMeasure: 'Grams',
          totalAmountCents: 1250,
        },
      ],
      licenseNumber: LICENSE,
      userKey: USER,
    });

    expect(outcome).toEqual({ acceptedAt: FIXED_NOW });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const req = dispatcher.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api-mn.metrc.com/sales/v2/receipts?licenseNumber=${LICENSE}`);
    expect(req.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${VENDOR}:${USER}`, 'utf8').toString('base64')}`,
    );
    expect(req.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(req.body!) as Array<{
      readonly SalesDateTime: string;
      readonly SalesCustomerType: string;
      readonly Transactions: Array<{ readonly TotalAmount: string }>;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.SalesDateTime).toBe('2026-05-19T14:55:00.000Z');
    expect(body[0]!.SalesCustomerType).toBe('Consumer');
    expect(body[0]!.Transactions[0]!.TotalAmount).toBe('12.50');
  });

  it('includes PatientLicenseNumber when supplied', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    await client.createReceipt({
      salesDateTime: new Date('2026-05-19T14:55:00Z'),
      salesCustomerType: 'Patient',
      patientLicenseNumber: 'PAT-001',
      transactions: [
        {
          packageLabel: 'PKG',
          quantity: '1',
          unitOfMeasure: 'Grams',
          totalAmountCents: 100,
        },
      ],
      licenseNumber: LICENSE,
      userKey: USER,
    });

    const req = dispatcher.mock.calls[0]![0];
    const body = JSON.parse(req.body!) as Array<{ readonly PatientLicenseNumber?: string }>;
    expect(body[0]!.PatientLicenseNumber).toBe('PAT-001');
  });

  it('omits PatientLicenseNumber when undefined (recreational sale)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    await client.createReceipt({
      salesDateTime: new Date('2026-05-19T14:55:00Z'),
      salesCustomerType: 'Consumer',
      transactions: [
        {
          packageLabel: 'PKG',
          quantity: '1',
          unitOfMeasure: 'Grams',
          totalAmountCents: 100,
        },
      ],
      licenseNumber: LICENSE,
      userKey: USER,
    });

    const req = dispatcher.mock.calls[0]![0];
    const body = JSON.parse(req.body!) as Array<Record<string, unknown>>;
    expect(body[0]).not.toHaveProperty('PatientLicenseNumber');
  });

  it('rejects an empty transactions list', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    await expect(
      client.createReceipt({
        salesDateTime: FIXED_NOW,
        salesCustomerType: 'Consumer',
        transactions: [],
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(ExternalServiceError);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('rejects an undefined transactions field (defensive, beyond TS guarantee)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    // The public type forbids `transactions: undefined`, but the
    // assertion has a defensive `undefined` arm because the request body
    // can theoretically originate from a non-TS caller (e.g. a
    // deserialized job payload). Exercise it explicitly so the assertion
    // doesn't regress to "TS-only" enforcement.
    const bad = {
      salesDateTime: FIXED_NOW,
      salesCustomerType: 'Consumer' as const,
      transactions: undefined as unknown as ReadonlyArray<never>,
      licenseNumber: LICENSE,
      userKey: USER,
    };

    await expect(client.createReceipt(bad)).rejects.toThrow(/at least one transaction/);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('rejects empty license and user keys before hitting the wire', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    const input = {
      salesDateTime: FIXED_NOW,
      salesCustomerType: 'Consumer',
      transactions: [
        { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: 1 },
      ],
    } as const;

    await expect(
      client.createReceipt({ ...input, licenseNumber: '', userKey: USER }),
    ).rejects.toThrow(/licenseNumber/);
    await expect(
      client.createReceipt({ ...input, licenseNumber: LICENSE, userKey: '' }),
    ).rejects.toThrow(/userKey/);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('rejects negative totalAmountCents at the body-building boundary', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    await expect(
      client.createReceipt({
        salesDateTime: FIXED_NOW,
        salesCustomerType: 'Consumer',
        transactions: [
          { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: -1 },
        ],
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('rejects non-integer totalAmountCents (e.g. 9.99)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const client = buildClient(dispatcher);

    await expect(
      client.createReceipt({
        salesDateTime: FIXED_NOW,
        salesCustomerType: 'Consumer',
        transactions: [
          { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: 9.99 },
        ],
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('translates upstream 401 to ExternalServiceError without retry', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(failResp(401, 'Unauthorized'));
    const client = buildClient(dispatcher);

    await expect(
      client.createReceipt({
        salesDateTime: FIXED_NOW,
        salesCustomerType: 'Consumer',
        transactions: [
          { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: 1 },
        ],
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/status 401/);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });
});

describe('MetrcClient.listActiveReceipts', () => {
  it('GETs /sales/v2/receipts/active with lastModified window and licenseNumber', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok([RECEIPT_FIXTURE]));
    const client = buildClient(dispatcher);

    const start = new Date('2026-05-19T00:00:00Z');
    const end = new Date('2026-05-20T00:00:00Z');
    const receipts = await client.listActiveReceipts({
      lastModifiedStart: start,
      lastModifiedEnd: end,
      licenseNumber: LICENSE,
      userKey: USER,
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toBe(42);
    expect(receipts[0]!.receiptNumber).toBe('RCP-0042');
    expect(receipts[0]!.salesDateTime.toISOString()).toBe('2026-05-19T14:55:00.000Z');
    expect(receipts[0]!.lastModified.toISOString()).toBe('2026-05-19T14:55:10.000Z');
    expect(receipts[0]!.totalPrice).toBe('12.50');
    expect(receipts[0]!.transactions[0]!.totalPrice).toBe('12.5');

    const req = dispatcher.mock.calls[0]![0];
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/sales/v2/receipts/active?');
    expect(req.url).toContain('lastModifiedStart=2026-05-19T00%3A00%3A00.000Z');
    expect(req.url).toContain('lastModifiedEnd=2026-05-20T00%3A00%3A00.000Z');
    expect(req.url.endsWith(`&licenseNumber=${LICENSE}`)).toBe(true);
  });

  it('rejects a non-positive lastModified window', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok([]));
    const client = buildClient(dispatcher);

    const sameInstant = new Date('2026-05-19T00:00:00Z');
    await expect(
      client.listActiveReceipts({
        lastModifiedStart: sameInstant,
        lastModifiedEnd: sameInstant,
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/strictly after/);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('rejects empty license/user keys', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok([]));
    const client = buildClient(dispatcher);

    await expect(
      client.listActiveReceipts({
        lastModifiedStart: new Date(0),
        lastModifiedEnd: new Date(1),
        licenseNumber: '',
        userKey: USER,
      }),
    ).rejects.toThrow(/licenseNumber/);
    await expect(
      client.listActiveReceipts({
        lastModifiedStart: new Date(0),
        lastModifiedEnd: new Date(1),
        licenseNumber: LICENSE,
        userKey: '',
      }),
    ).rejects.toThrow(/userKey/);
  });

  it('wraps a schema-invalid response in ExternalServiceError', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValue(ok([{ Id: 'not-a-number', ReceiptNumber: 'X' }]));
    const client = buildClient(dispatcher);

    await expect(
      client.listActiveReceipts({
        lastModifiedStart: new Date(0),
        lastModifiedEnd: new Date(1),
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/failed schema validation/);
  });

  it('wraps non-JSON response in ExternalServiceError', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: '<html>oops</html>',
    });
    const client = buildClient(dispatcher);

    await expect(
      client.listActiveReceipts({
        lastModifiedStart: new Date(0),
        lastModifiedEnd: new Date(1),
        licenseNumber: LICENSE,
        userKey: USER,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe('MetrcClient.getReceipt', () => {
  it('GETs /sales/v2/receipts/:id and parses the body', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(RECEIPT_FIXTURE));
    const client = buildClient(dispatcher);

    const receipt = await client.getReceipt({ id: 42, licenseNumber: LICENSE, userKey: USER });

    expect(receipt.id).toBe(42);
    expect(receipt.transactions).toHaveLength(1);
    expect(receipt.transactions[0]!.packageLabel).toBe('1A4FF01000000220000123');

    const req = dispatcher.mock.calls[0]![0];
    expect(req.url).toBe(`https://api-mn.metrc.com/sales/v2/receipts/42?licenseNumber=${LICENSE}`);
  });

  it('rejects a non-positive id', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(RECEIPT_FIXTURE));
    const client = buildClient(dispatcher);

    await expect(
      client.getReceipt({ id: 0, licenseNumber: LICENSE, userKey: USER }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      client.getReceipt({ id: 1.5, licenseNumber: LICENSE, userKey: USER }),
    ).rejects.toThrow(/positive integer/);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('rejects empty license/user keys', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(RECEIPT_FIXTURE));
    const client = buildClient(dispatcher);

    await expect(client.getReceipt({ id: 1, licenseNumber: '', userKey: USER })).rejects.toThrow(
      /licenseNumber/,
    );
    await expect(client.getReceipt({ id: 1, licenseNumber: LICENSE, userKey: '' })).rejects.toThrow(
      /userKey/,
    );
  });

  it('translates upstream 404 to ExternalServiceError', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(failResp(404, 'not found'));
    const client = buildClient(dispatcher);

    await expect(
      client.getReceipt({ id: 999, licenseNumber: LICENSE, userKey: USER }),
    ).rejects.toThrow(/status 404/);
  });

  it('translates upstream 500 to ExternalServiceError after retries exhaust', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(failResp(500, 'boom'));
    const client = buildClient(dispatcher);

    await expect(
      client.getReceipt({ id: 1, licenseNumber: LICENSE, userKey: USER }),
    ).rejects.toThrow(/status 500/);
  });
});

describe('MetrcClient construction', () => {
  it('strips a trailing slash from apiBaseUrl', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const http = new HttpClient({ dispatcher, retries: 0, sleep: () => Promise.resolve() });
    const client = new MetrcClient({
      apiBaseUrl: 'https://api-mn.metrc.com///',
      vendorKey: VENDOR,
      http,
      clock: () => FIXED_NOW,
    });
    await client.createReceipt({
      salesDateTime: FIXED_NOW,
      salesCustomerType: 'Consumer',
      transactions: [
        { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: 1 },
      ],
      licenseNumber: LICENSE,
      userKey: USER,
    });
    const req = dispatcher.mock.calls[0]![0];
    expect(req.url.startsWith('https://api-mn.metrc.com/sales/')).toBe(true);
    expect(req.url).not.toContain('com//');
  });

  it('uses the system clock when no clock injector is supplied', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok(''));
    const http = new HttpClient({ dispatcher, retries: 0, sleep: () => Promise.resolve() });
    const client = new MetrcClient({
      apiBaseUrl: 'https://api-mn.metrc.com',
      vendorKey: VENDOR,
      http,
    });
    const before = Date.now();
    const outcome = await client.createReceipt({
      salesDateTime: new Date(),
      salesCustomerType: 'Consumer',
      transactions: [
        { packageLabel: 'P', quantity: '1', unitOfMeasure: 'Grams', totalAmountCents: 1 },
      ],
      licenseNumber: LICENSE,
      userKey: USER,
    });
    const after = Date.now();
    expect(outcome.acceptedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(outcome.acceptedAt.getTime()).toBeLessThanOrEqual(after);
  });
});
