/**
 * Unit tests for AdminProductsController.
 *
 * Controller owns route-param plumbing and response shape (each mutator
 * returns a single ProductResponse, not an envelope). Auth wiring is
 * verified at the module composition level.
 */
import { describe, expect, it } from 'vitest';
import { AdminProductsController } from './admin-products.controller.js';
import type { AdminProductsService } from './admin-products.service.js';
import type { ProductResponse } from '../dto/index.js';
import type {
  CreateLabResultRequest,
  CreateProductRequest,
  PatchProductRequest,
} from './dto/index.js';

const PRODUCT: ProductResponse = {
  id: '01935f3d-0000-7000-8000-000000000001',
  categoryId: '01935f3d-0000-7000-8000-000000000010',
  brand: 'North Star',
  name: 'Pineapple Express 3.5g',
  description: null,
  productType: 'flower',
  strainType: 'sativa',
  thcMgPerUnit: '875.000',
  cbdMgPerUnit: '0',
  weightGramsPerUnit: '3.500',
  servingCount: null,
  thcMgPerServing: null,
  imageKeys: [],
  effectsTags: [],
  flavorTags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  labResults: [],
};

class FakeAdminProductsService {
  public createCalls: CreateProductRequest[] = [];
  public patchCalls: { id: string; body: PatchProductRequest }[] = [];
  public labResultCalls: { id: string; body: CreateLabResultRequest }[] = [];

  create = (body: CreateProductRequest): Promise<ProductResponse> => {
    this.createCalls.push(body);
    return Promise.resolve({ ...PRODUCT, brand: body.brand, name: body.name });
  };
  patch = (id: string, body: PatchProductRequest): Promise<ProductResponse> => {
    this.patchCalls.push({ id, body });
    return Promise.resolve({ ...PRODUCT, id, brand: body.brand ?? PRODUCT.brand });
  };
  createLabResult = (id: string, body: CreateLabResultRequest): Promise<ProductResponse> => {
    this.labResultCalls.push({ id, body });
    return Promise.resolve({
      ...PRODUCT,
      id,
      labResults: [
        {
          id: '01935f3d-0000-7000-8000-0000000000dd',
          batchId: body.batchId,
          labName: body.labName,
          coaDocumentKey: body.coaDocumentKey ?? null,
          potencyThc: body.potencyThc ?? null,
          potencyCbd: body.potencyCbd ?? null,
          contaminantsPassed: body.contaminantsPassed ?? null,
          testedAt: body.testedAt,
        },
      ],
    });
  };
}

function makeCreateBody(): CreateProductRequest {
  return {
    categoryId: '01935f3d-0000-7000-8000-000000000010',
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
  };
}

describe('AdminProductsController.create', () => {
  it('forwards the body and returns a single ProductResponse (no envelope)', async () => {
    const svc = new FakeAdminProductsService();
    const controller = new AdminProductsController(svc as unknown as AdminProductsService);

    const body = makeCreateBody();
    const res = await controller.create(body);

    expect(svc.createCalls).toEqual([body]);
    expect(res.brand).toBe('North Star');
  });
});

describe('AdminProductsController.patch', () => {
  it('forwards the route param and body verbatim', async () => {
    const svc = new FakeAdminProductsService();
    const controller = new AdminProductsController(svc as unknown as AdminProductsService);

    const res = await controller.patch('01935f3d-0000-7000-8000-000000000001', {
      brand: 'Renamed',
    });

    expect(svc.patchCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-000000000001', body: { brand: 'Renamed' } },
    ]);
    expect(res.brand).toBe('Renamed');
  });
});

describe('AdminProductsController.createLabResult', () => {
  it('forwards the route param and body, returns the inflated product', async () => {
    const svc = new FakeAdminProductsService();
    const controller = new AdminProductsController(svc as unknown as AdminProductsService);

    const body: CreateLabResultRequest = {
      batchId: 'OCM-BATCH-001',
      labName: 'Steep Hill Minnesota',
      testedAt: '2026-05-01',
    };
    const res = await controller.createLabResult('01935f3d-0000-7000-8000-000000000001', body);

    expect(svc.labResultCalls).toEqual([{ id: '01935f3d-0000-7000-8000-000000000001', body }]);
    expect(res.labResults).toHaveLength(1);
    expect(res.labResults[0]?.batchId).toBe('OCM-BATCH-001');
  });
});
