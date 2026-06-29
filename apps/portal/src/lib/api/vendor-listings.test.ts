import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import {
  deleteVendorListing,
  isUploadableListingImageType,
  listVendorListings,
  patchVendorListing,
  requestListingImageUpload,
  triggerVendorListingsSync,
  uploadListingImageToStorage,
  ListingImageUploadError,
  type ListingImageUploadTicket,
  type ListVendorListingsResult,
  type SyncVendorListingsResult,
  type VendorListing,
  type VendorListingWithProduct,
} from './vendor-listings.js';

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
  const body = typeof init?.body === 'string' ? init.body : null;
  return { url, method: init?.method ?? 'GET', headers, body };
}

function buildResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const LISTING_ID = '01935f3d-0000-7000-8000-0000000000e1';

const SAMPLE_LISTING: VendorListing = {
  id: LISTING_ID,
  dispensaryId: DISPENSARY_ID,
  productId: '01935f3d-0000-7000-8000-0000000000f1',
  sku: 'FLOWER-OG-1G',
  priceCents: 1500,
  compareAtPriceCents: null,
  quantityAvailable: 42,
  imageKeys: [],
  metrcPackageTag: '1A4FF010000022B000000023',
  lastSyncedAt: '2026-05-19T10:00:00.000Z',
  isActive: true,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-19T10:00:00.000Z',
};

const SAMPLE_LISTING_WITH_PRODUCT: VendorListingWithProduct = {
  ...SAMPLE_LISTING,
  product: {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    brand: 'North Star',
    name: 'OG Kush 1g',
    productType: 'flower',
    strainType: 'indica',
    thcMgPerUnit: '250.000',
    weightGramsPerUnit: '1.000',
    imageKeys: [],
    isActive: true,
    deletedAt: null,
  },
};

function newClient(handler: (req: CapturedRequest) => Response): {
  client: ApiClient;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = captureRequest(input, init);
    captured.push(req);
    return handler(req);
  });
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    accessToken: 'access-1',
    dispensaryId: DISPENSARY_ID,
    fetchImpl,
  });
  return { client, captured };
}

describe('listVendorListings', () => {
  it('GETs /v1/vendor/listings with the dispensary header', async () => {
    const body: ListVendorListingsResult = { listings: [SAMPLE_LISTING_WITH_PRODUCT] };
    const { client, captured } = newClient(() => buildResponse(200, body));

    const result = await listVendorListings(client);

    expect(result).toEqual(body);
    expect(result.listings[0]?.product.brand).toBe('North Star');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/listings');
    expect(captured[0]?.method).toBe('GET');
    expect(captured[0]?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
  });
});

describe('patchVendorListing', () => {
  it('PATCHes /v1/vendor/listings/:id with the JSON body', async () => {
    const { client, captured } = newClient(() =>
      buildResponse(200, { ...SAMPLE_LISTING, priceCents: 1750 }),
    );

    const result = await patchVendorListing(client, LISTING_ID, { priceCents: 1750 });

    expect(result.priceCents).toBe(1750);
    const req = captured[0];
    expect(req).toBeDefined();
    expect(req?.method).toBe('PATCH');
    expect(req?.url).toBe(`https://api.test/v1/vendor/listings/${LISTING_ID}`);
    expect(req?.headers['Content-Type']).toBe('application/json');
    expect(req?.body).not.toBeNull();
    expect(req?.body !== null && req?.body !== undefined && JSON.parse(req.body)).toEqual({
      priceCents: 1750,
    });
  });

  it('encodes the listing id so a bare slash in the path is safe', async () => {
    const { client, captured } = newClient(() => buildResponse(200, SAMPLE_LISTING));

    await patchVendorListing(client, 'weird/id with space', { isActive: false });

    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/listings/weird%2Fid%20with%20space');
  });
});

describe('deleteVendorListing', () => {
  it('DELETEs /v1/vendor/listings/:id and resolves without a body', async () => {
    const { client, captured } = newClient(() => new Response(null, { status: 204 }));

    await expect(deleteVendorListing(client, LISTING_ID)).resolves.toBeUndefined();

    expect(captured[0]?.method).toBe('DELETE');
    expect(captured[0]?.url).toBe(`https://api.test/v1/vendor/listings/${LISTING_ID}`);
  });
});

describe('triggerVendorListingsSync', () => {
  it('POSTs /v1/vendor/listings/sync and returns the sync result', async () => {
    const body: SyncVendorListingsResult = {
      updated: 4,
      syncedAt: '2026-05-20T12:00:00.000Z',
    };
    const { client, captured } = newClient(() => buildResponse(200, body));

    const result = await triggerVendorListingsSync(client);

    expect(result).toEqual(body);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.url).toBe('https://api.test/v1/vendor/listings/sync');
  });
});

describe('isUploadableListingImageType', () => {
  it('accepts the three storable image types and rejects everything else', () => {
    expect(isUploadableListingImageType('image/jpeg')).toBe(true);
    expect(isUploadableListingImageType('image/png')).toBe(true);
    expect(isUploadableListingImageType('image/webp')).toBe(true);
    expect(isUploadableListingImageType('image/gif')).toBe(false);
    expect(isUploadableListingImageType('image/svg+xml')).toBe(false);
    expect(isUploadableListingImageType('application/pdf')).toBe(false);
  });
});

describe('requestListingImageUpload', () => {
  it('POSTs the content type to /v1/vendor/listings/image-uploads and returns the ticket', async () => {
    const ticket: ListingImageUploadTicket = {
      uploadUrl: 'https://account.r2.cloudflarestorage.com/dankdash',
      fields: {
        key: `dispensaries/${DISPENSARY_ID}/listings/abc.jpg`,
        'Content-Type': 'image/jpeg',
      },
      objectKey: `dispensaries/${DISPENSARY_ID}/listings/abc.jpg`,
      expiresAt: '2026-06-07T12:05:00.000Z',
    };
    const { client, captured } = newClient(() => buildResponse(201, ticket));

    const result = await requestListingImageUpload(client, 'image/jpeg');

    expect(result).toEqual(ticket);
    const req = captured[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://api.test/v1/vendor/listings/image-uploads');
    expect(req?.headers['X-Dispensary-Id']).toBe(DISPENSARY_ID);
    expect(req?.body !== null && req?.body !== undefined && JSON.parse(req.body)).toEqual({
      contentType: 'image/jpeg',
    });
  });
});

describe('uploadListingImageToStorage', () => {
  const TICKET: ListingImageUploadTicket = {
    uploadUrl: 'https://account.r2.cloudflarestorage.com/dankdash',
    fields: {
      key: `dispensaries/${DISPENSARY_ID}/listings/abc.webp`,
      'Content-Type': 'image/webp',
      Policy: 'eyJ...',
      'X-Amz-Signature': 'deadbeef',
    },
    objectKey: `dispensaries/${DISPENSARY_ID}/listings/abc.webp`,
    expiresAt: '2026-06-07T12:05:00.000Z',
  };

  it('submits every policy field then the file last, and returns the object key', async () => {
    let captured: FormData | null = null;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.body as FormData;
      return new Response(null, { status: 204 });
    });
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

    const key = await uploadListingImageToStorage(
      TICKET,
      file,
      fetchImpl as unknown as typeof fetch,
    );

    expect(key).toBe(TICKET.objectKey);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const form = captured as unknown as FormData;
    const entries = [...form.keys()];
    expect(entries).toEqual(['key', 'Content-Type', 'Policy', 'X-Amz-Signature', 'file']);
    expect(entries.at(-1)).toBe('file');
    expect(form.get('key')).toBe(TICKET.fields.key);
  });

  it('throws ListingImageUploadError with the HTTP status when storage rejects the policy', async () => {
    const fetchImpl = vi.fn(async () => new Response('AccessDenied', { status: 403 }));
    const file = new Blob([new Uint8Array([1])], { type: 'image/webp' });

    await expect(
      uploadListingImageToStorage(TICKET, file, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ name: 'ImageUploadError', status: 403 });
  });

  it('wraps a network failure as ListingImageUploadError with a null status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const file = new Blob([new Uint8Array([1])], { type: 'image/webp' });

    const error = await uploadListingImageToStorage(
      TICKET,
      file,
      fetchImpl as unknown as typeof fetch,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ListingImageUploadError);
    expect((error as ListingImageUploadError).status).toBeNull();
  });
});
