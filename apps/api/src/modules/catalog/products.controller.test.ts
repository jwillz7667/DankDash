/**
 * Unit tests for ProductsController.
 *
 * The controller is a one-line pass-through to ProductsService.getById; the
 * meaningful surface is parameter wiring (the @Param flows through unchanged).
 * The ParseUUIDPipe behaviour itself is covered by Nest core tests — we
 * only verify the controller hands the id off correctly.
 */
import { describe, expect, it } from 'vitest';
import { ProductsController } from './products.controller.js';
import type { ProductResponse } from './dto/index.js';
import type { ProductsService } from './products.service.js';

const PRODUCT: ProductResponse = {
  id: '01935f3d-0000-7000-8000-000000000001',
  categoryId: '01935f3d-0000-7000-8000-0000000000a1',
  brand: 'Sunny Side',
  name: 'Sour Tangie 3.5g',
  description: null,
  productType: 'flower',
  strainType: 'sativa',
  thcMgPerUnit: '24.500',
  cbdMgPerUnit: '0.100',
  weightGramsPerUnit: '3.500',
  servingCount: null,
  thcMgPerServing: null,
  imageKeys: [],
  effectsTags: [],
  flavorTags: [],
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
  labResults: [],
};

class FakeProductsService {
  public calls: string[] = [];

  getById = (id: string): Promise<ProductResponse> => {
    this.calls.push(id);
    return Promise.resolve(PRODUCT);
  };
}

describe('ProductsController.getById', () => {
  it('forwards the route param to ProductsService.getById', async () => {
    const svc = new FakeProductsService();
    const controller = new ProductsController(svc as unknown as ProductsService);

    const res = await controller.getById('01935f3d-0000-7000-8000-000000000001');

    expect(res).toEqual(PRODUCT);
    expect(svc.calls).toEqual(['01935f3d-0000-7000-8000-000000000001']);
  });
});
