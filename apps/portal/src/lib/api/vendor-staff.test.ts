import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import {
  inviteVendorStaff,
  listVendorStaff,
  patchVendorStaffRole,
  removeVendorStaff,
  type VendorStaffMember,
} from './vendor-staff.js';

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
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const STAFF_ID = '01935f3d-0000-7000-8000-0000000000a3';

const SAMPLE_MEMBER: VendorStaffMember = {
  id: STAFF_ID,
  userId: '01935f3d-0000-7000-8000-0000000000a5',
  role: 'manager',
  email: 'mgr@example.com',
  firstName: 'Casey',
  lastName: 'Manager',
  mfaEnabled: true,
  lastLoginAt: '2026-05-19T12:00:00.000Z',
  invitedAt: '2026-05-01T00:00:00.000Z',
  acceptedAt: '2026-05-01T01:00:00.000Z',
  removedAt: null,
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

describe('listVendorStaff', () => {
  it('GETs /v1/vendor/staff with the dispensary header', async () => {
    const { client, captured } = newClient(200, { staff: [SAMPLE_MEMBER] });

    const result = await listVendorStaff(client);

    expect(result).toEqual({ staff: [SAMPLE_MEMBER] });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/staff');
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });
});

describe('inviteVendorStaff', () => {
  it('POSTs /v1/vendor/staff with email + role', async () => {
    const { client, captured } = newClient(201, SAMPLE_MEMBER);

    const result = await inviteVendorStaff(client, {
      email: 'invitee@example.com',
      role: 'budtender',
    });

    expect(result).toEqual(SAMPLE_MEMBER);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/staff');
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      email: 'invitee@example.com',
      role: 'budtender',
    });
  });
});

describe('patchVendorStaffRole', () => {
  it('PATCHes /v1/vendor/staff/:id with the new role', async () => {
    const { client, captured } = newClient(200, SAMPLE_MEMBER);

    const result = await patchVendorStaffRole(client, STAFF_ID, { role: 'manager' });

    expect(result).toEqual(SAMPLE_MEMBER);
    expect(captured[0]?.method).toBe('PATCH');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/staff/${STAFF_ID}`);
    expect(JSON.parse(captured[0]!.body!)).toEqual({ role: 'manager' });
  });

  it('url-encodes the staff id', async () => {
    const { client, captured } = newClient(200, SAMPLE_MEMBER);

    await patchVendorStaffRole(client, 'with space/slash', { role: 'manager' });

    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/staff/with%20space%2Fslash');
  });
});

describe('removeVendorStaff', () => {
  it('DELETEs /v1/vendor/staff/:id with no body', async () => {
    const { client, captured } = newClient(204, null);

    await removeVendorStaff(client, STAFF_ID);

    expect(captured[0]?.method).toBe('DELETE');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/staff/${STAFF_ID}`);
    expect(captured[0]?.body).toBeNull();
  });
});
