/**
 * Unit tests for CategoriesController.
 *
 * The controller is a one-line pass-through to CategoriesService; the
 * meaningful surface it owns is the response wrapping (`{ categories: [...] }`)
 * — the iOS client expects an object envelope so additional response
 * metadata (a future `lastUpdatedAt` for cache hints) can be added without
 * a breaking change to the parse path.
 */
import { describe, expect, it } from 'vitest';
import { CategoriesController } from './categories.controller.js';
import type { CategoriesService } from './categories.service.js';
import type { CategoryResponse } from './dto/index.js';

const CATEGORY: CategoryResponse = {
  id: '01935f3d-0000-7000-8000-000000000001',
  slug: 'flower',
  displayName: 'Flower',
  parentId: null,
  displayOrder: 0,
  iconKey: null,
};

class FakeCategoriesService {
  public calls = 0;
  public next: readonly CategoryResponse[] = [];

  list = (): Promise<readonly CategoryResponse[]> => {
    this.calls += 1;
    return Promise.resolve(this.next);
  };
}

describe('CategoriesController.list', () => {
  it('wraps the service result in the `{ categories: [...] }` envelope', async () => {
    const svc = new FakeCategoriesService();
    svc.next = [CATEGORY];
    const controller = new CategoriesController(svc as unknown as CategoriesService);

    const res = await controller.list();

    expect(res).toEqual({ categories: [CATEGORY] });
    expect(svc.calls).toBe(1);
  });

  it('returns an empty envelope when the catalog has no categories', async () => {
    const svc = new FakeCategoriesService();
    const controller = new CategoriesController(svc as unknown as CategoriesService);

    const res = await controller.list();

    expect(res).toEqual({ categories: [] });
  });
});
