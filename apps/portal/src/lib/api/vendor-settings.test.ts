import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import { getVendorSettings, patchVendorSettings, type VendorSettings } from './vendor-settings.js';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
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
  const bodyValue = init?.body;
  const body = typeof bodyValue === 'string' ? bodyValue : null;
  return { url, method: init?.method ?? 'GET', headers, body };
}

function buildResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';

const SAMPLE: VendorSettings = {
  id: DISPENSARY_ID,
  legalName: 'North Star LLC',
  dba: null,
  licenseNumber: 'MN-2025-0001',
  licenseType: 'retailer',
  licenseIssuedAt: '2025-01-01',
  licenseExpiresAt: '2027-01-01',
  addressLine1: '1 Main St',
  addressLine2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.265, 44.978] },
  deliveryPolygon: {
    type: 'Polygon',
    coordinates: [
      [
        [-93.3, 44.95],
        [-93.2, 44.95],
        [-93.2, 45.0],
        [-93.3, 45.0],
        [-93.3, 44.95],
      ],
    ],
  },
  hours: {
    mon: { open: '08:00', close: '22:00' },
    tue: { open: '08:00', close: '22:00' },
    wed: { open: '08:00', close: '22:00' },
    thu: { open: '08:00', close: '22:00' },
    fri: { open: '08:00', close: '22:00' },
    sat: { open: '10:00', close: '22:00' },
    sun: null,
  },
  phone: '+1-612-555-0100',
  email: 'hi@northstar.example',
  logoImageKey: null,
  heroImageKey: null,
  brandColorHex: '#1A4314',
  isAcceptingOrders: true,
  status: 'active',
  posProvider: 'manual',
  posLastSyncedAt: null,
  hasPosCredentials: false,
  metrcFacilityId: null,
  hasMetrcCredentials: false,
  hasAeropayAccount: false,
  createdAt: '2025-12-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
};

function newClient(
  status: number,
  body: unknown,
): {
  client: ApiClient;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(captureRequest(input, init));
    return buildResponse(status, body);
  });
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    accessToken: 'access-1',
    dispensaryId: DISPENSARY_ID,
    fetchImpl,
  });
  return { client, captured };
}

describe('getVendorSettings', () => {
  it('GETs /v1/vendor/settings with the dispensary header', async () => {
    const { client, captured } = newClient(200, SAMPLE);

    const result = await getVendorSettings(client);

    expect(result).toEqual(SAMPLE);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/settings');
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });
});

describe('patchVendorSettings', () => {
  it('PATCHes /v1/vendor/settings with the body', async () => {
    const { client, captured } = newClient(200, SAMPLE);

    const result = await patchVendorSettings(client, { isAcceptingOrders: false });

    expect(result).toEqual(SAMPLE);
    expect(captured[0]?.method).toBe('PATCH');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/settings');
    expect(JSON.parse(captured[0]!.body!)).toEqual({ isAcceptingOrders: false });
  });

  it('sends a full hours payload when supplied', async () => {
    const { client, captured } = newClient(200, SAMPLE);

    await patchVendorSettings(client, { hours: SAMPLE.hours });

    expect(JSON.parse(captured[0]!.body!)).toEqual({ hours: SAMPLE.hours });
  });
});
