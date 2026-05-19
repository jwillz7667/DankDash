/**
 * Unit tests for AdminCategoriesController.
 *
 * The controller is a thin pass-through to AdminCategoriesService; what it
 * owns is the body forwarding and the response shape (a single
 * CategoryResponse, not an envelope). Guard wiring (RolesGuard + global
 * JwtAuthGuard) is verified at the module composition level.
 */
import { describe, expect, it } from 'vitest';
import { AdminCategoriesController } from './admin-categories.controller.js';
import type { AdminCategoriesService } from './admin-categories.service.js';
import type { CategoryResponse } from '../dto/index.js';
import type { CreateCategoryRequest } from './dto/index.js';

const CATEGORY: CategoryResponse = {
  id: '01935f3d-0000-7000-8000-000000000010',
  slug: 'edibles',
  displayName: 'Edibles',
  parentId: null,
  displayOrder: 0,
  iconKey: null,
};

class FakeAdminCategoriesService {
  public createCalls: CreateCategoryRequest[] = [];

  create = (body: CreateCategoryRequest): Promise<CategoryResponse> => {
    this.createCalls.push(body);
    return Promise.resolve({ ...CATEGORY, slug: body.slug, displayName: body.displayName });
  };
}

describe('AdminCategoriesController.create', () => {
  it('forwards the body and returns a single CategoryResponse (no envelope)', async () => {
    const svc = new FakeAdminCategoriesService();
    const controller = new AdminCategoriesController(svc as unknown as AdminCategoriesService);

    const body: CreateCategoryRequest = { slug: 'edibles', displayName: 'Edibles' };
    const res = await controller.create(body);

    expect(svc.createCalls).toEqual([body]);
    expect(res.slug).toBe('edibles');
    expect(res.displayName).toBe('Edibles');
  });
});
