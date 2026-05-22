/**
 * Unit tests for VendorListingsController.
 *
 * Controller owns route-param plumbing and response shape. Auth wiring
 * (VendorContextGuard + RolesGuard) is verified at the module
 * composition level; here we exercise that the controller threads
 * `@CurrentDispensary() ctx` and `@Param('id')` verbatim to the service.
 *
 *   - GET   → forwards ctx, returns ListingListResponse envelope.
 *   - POST  → forwards (ctx, body), returns single ListingResponse.
 *   - PATCH → forwards (ctx, id, body) verbatim.
 *   - DELETE→ forwards (ctx, id), returns void (HTTP 204).
 */
import { describe, expect, it } from 'vitest';
import { VendorListingsController } from './vendor-listings.controller.js';
import type {
  CreateListingRequest,
  ListingListResponse,
  ListingResponse,
  ListingWithProductResponse,
  PatchListingRequest,
} from './dto/index.js';
import type { VendorContext } from './vendor-context.types.js';
import type { VendorListingsService } from './vendor-listings.service.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const STAFF_ID = '01935f3d-0000-7000-8000-000000000050';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000020';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';

const CTX: VendorContext = {
  dispensaryId: DISPENSARY_ID,
  userId: USER_ID,
  staffRole: 'manager',
  staffMemberId: STAFF_ID,
};

const LISTING: ListingResponse = {
  id: LISTING_ID,
  dispensaryId: DISPENSARY_ID,
  productId: PRODUCT_ID,
  sku: 'NS-PE-3.5G',
  priceCents: 4500,
  compareAtPriceCents: null,
  quantityAvailable: 10,
  metrcPackageTag: null,
  lastSyncedAt: null,
  isActive: true,
  createdAt: '2026-05-18T19:00:00.000Z',
  updatedAt: '2026-05-18T19:00:00.000Z',
};

const LISTING_WITH_PRODUCT: ListingWithProductResponse = {
  ...LISTING,
  product: {
    id: PRODUCT_ID,
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
    imageKeys: [],
    isActive: true,
    deletedAt: null,
  },
};

class FakeVendorListingsService {
  public listCalls: VendorContext[] = [];
  public createCalls: { ctx: VendorContext; body: CreateListingRequest }[] = [];
  public patchCalls: { ctx: VendorContext; id: string; body: PatchListingRequest }[] = [];
  public deleteCalls: { ctx: VendorContext; id: string }[] = [];
  public syncCalls: VendorContext[] = [];

  list = (ctx: VendorContext): Promise<ListingListResponse> => {
    this.listCalls.push(ctx);
    return Promise.resolve({ listings: [LISTING_WITH_PRODUCT] });
  };
  create = (ctx: VendorContext, body: CreateListingRequest): Promise<ListingResponse> => {
    this.createCalls.push({ ctx, body });
    return Promise.resolve({ ...LISTING, sku: body.sku, priceCents: body.priceCents });
  };
  patch = (ctx: VendorContext, id: string, body: PatchListingRequest): Promise<ListingResponse> => {
    this.patchCalls.push({ ctx, id, body });
    return Promise.resolve({ ...LISTING, id, priceCents: body.priceCents ?? LISTING.priceCents });
  };
  delete = (ctx: VendorContext, id: string): Promise<void> => {
    this.deleteCalls.push({ ctx, id });
    return Promise.resolve();
  };
  sync = (ctx: VendorContext): Promise<{ readonly updated: number; readonly syncedAt: string }> => {
    this.syncCalls.push(ctx);
    return Promise.resolve({ updated: 3, syncedAt: '2026-05-20T12:00:00.000Z' });
  };
}

describe('VendorListingsController.list', () => {
  it('forwards ctx and returns the envelope', async () => {
    const svc = new FakeVendorListingsService();
    const controller = new VendorListingsController(svc as unknown as VendorListingsService);

    const res = await controller.list(CTX);

    expect(svc.listCalls).toEqual([CTX]);
    expect(res).toEqual({ listings: [LISTING_WITH_PRODUCT] });
  });
});

describe('VendorListingsController.create', () => {
  it('forwards (ctx, body) and returns a single ListingResponse', async () => {
    const svc = new FakeVendorListingsService();
    const controller = new VendorListingsController(svc as unknown as VendorListingsService);

    const body: CreateListingRequest = {
      productId: PRODUCT_ID,
      sku: 'NS-NEW-1G',
      priceCents: 1500,
    };
    const res = await controller.create(CTX, body);

    expect(svc.createCalls).toEqual([{ ctx: CTX, body }]);
    expect(res.sku).toBe('NS-NEW-1G');
    expect(res.priceCents).toBe(1500);
  });
});

describe('VendorListingsController.patch', () => {
  it('forwards (ctx, id, body) verbatim', async () => {
    const svc = new FakeVendorListingsService();
    const controller = new VendorListingsController(svc as unknown as VendorListingsService);

    const res = await controller.patch(CTX, LISTING_ID, { priceCents: 6000 });

    expect(svc.patchCalls).toEqual([{ ctx: CTX, id: LISTING_ID, body: { priceCents: 6000 } }]);
    expect(res.priceCents).toBe(6000);
  });
});

describe('VendorListingsController.delete', () => {
  it('forwards (ctx, id) and resolves to undefined (HTTP 204)', async () => {
    const svc = new FakeVendorListingsService();
    const controller = new VendorListingsController(svc as unknown as VendorListingsService);

    await expect(controller.delete(CTX, LISTING_ID)).resolves.toBeUndefined();

    expect(svc.deleteCalls).toEqual([{ ctx: CTX, id: LISTING_ID }]);
  });
});

describe('VendorListingsController.sync', () => {
  it('forwards ctx and returns the {updated, syncedAt} envelope', async () => {
    const svc = new FakeVendorListingsService();
    const controller = new VendorListingsController(svc as unknown as VendorListingsService);

    const res = await controller.sync(CTX);

    expect(svc.syncCalls).toEqual([CTX]);
    expect(res).toEqual({ updated: 3, syncedAt: '2026-05-20T12:00:00.000Z' });
  });
});
