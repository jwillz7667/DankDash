import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import {
  getVendorPayout,
  listVendorPayouts,
  type VendorPayoutDetail,
  type VendorPayoutListResult,
} from './vendor-payouts.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function captureRequest(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const url = typeof input === 'string' ? input : input.toString();
  const headers: Record<string, string> = {};
  const raw = init?.headers;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (raw) {
    Object.assign(headers, raw as Record<string, string>);
  }
  return { url, method: init?.method ?? 'GET', headers };
}

function buildResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const PAYOUT_ID = '01935f3d-0000-7000-8000-0000000000b1';

const SAMPLE_LIST: VendorPayoutListResult = {
  payouts: [
    {
      id: PAYOUT_ID,
      periodStart: '2026-05-17',
      periodEnd: '2026-05-18',
      grossCents: 125_000,
      feesCents: 1_500,
      netCents: 123_500,
      status: 'completed',
      scheduledFor: '2026-05-18',
      aeropayPayoutRef: 'aero_payout_123',
      initiatedAt: '2026-05-18T08:00:00.000Z',
      completedAt: '2026-05-18T08:15:00.000Z',
      failureReason: null,
      createdAt: '2026-05-18T08:00:00.000Z',
    },
  ],
};

const SAMPLE_DETAIL: VendorPayoutDetail = {
  ...SAMPLE_LIST.payouts[0]!,
  orders: [
    {
      id: '01935f3d-0000-7000-8000-0000000000c1',
      shortCode: 'DD-AAAA-01',
      deliveredAt: '2026-05-17T22:13:00.000Z',
      subtotalCents: 4500,
      discountCents: 0,
      totalCents: 5000,
      customerFirstName: 'Jane',
      customerLastName: 'Doe',
    },
  ],
};

function newClient(body: unknown): { client: ApiClient; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(captureRequest(input, init));
    return buildResponse(200, body);
  });
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    accessToken: 'access-1',
    dispensaryId: DISPENSARY_ID,
    fetchImpl,
  });
  return { client, captured };
}

describe('listVendorPayouts', () => {
  it('GETs /v1/vendor/payouts', async () => {
    const { client, captured } = newClient(SAMPLE_LIST);

    const result = await listVendorPayouts(client);

    expect(result).toEqual(SAMPLE_LIST);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/payouts');
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });
});

describe('getVendorPayout', () => {
  it('GETs /v1/vendor/payouts/:id', async () => {
    const { client, captured } = newClient(SAMPLE_DETAIL);

    const result = await getVendorPayout(client, PAYOUT_ID);

    expect(result).toEqual(SAMPLE_DETAIL);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/payouts/${PAYOUT_ID}`);
  });

  it('url-encodes the payout id', async () => {
    const { client, captured } = newClient(SAMPLE_DETAIL);

    await getVendorPayout(client, 'with space/slash');

    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/payouts/with%20space%2Fslash');
  });
});
