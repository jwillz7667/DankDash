/**
 * Unit tests for CategoriesService.
 *
 * The service is a thin orchestration over ProductCategoriesRepository, so
 * what we lock down here is:
 *
 *   - list() — projection (every column surfaces with its correct
 *              public name, nullables stay null) and order preservation
 *              (the repository returns rows already sorted by
 *              `display_order`; the service must not re-sort or drop
 *              elements).
 */
import { type ProductCategoriesRepository, type ProductCategory } from '@dankdash/db';
import { describe, expect, it } from 'vitest';
import { CategoriesService } from './categories.service.js';

function makeCategory(overrides: Partial<ProductCategory> = {}): ProductCategory {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    slug: 'flower',
    displayName: 'Flower',
    parentId: null,
    displayOrder: 0,
    iconKey: null,
    ...overrides,
  };
}

class FakeCategoriesRepo implements Pick<ProductCategoriesRepository, 'listAll'> {
  public rows: readonly ProductCategory[] = [];

  seed(rows: readonly ProductCategory[]): void {
    this.rows = rows;
  }

  listAll(): Promise<readonly ProductCategory[]> {
    return Promise.resolve(this.rows);
  }
}

function makeRig(): { service: CategoriesService; repo: FakeCategoriesRepo } {
  const repo = new FakeCategoriesRepo();
  const service = new CategoriesService(repo as unknown as ProductCategoriesRepository);
  return { service, repo };
}

describe('CategoriesService.list', () => {
  it('projects every category row into the public CategoryResponse shape', async () => {
    const { service, repo } = makeRig();
    repo.seed([
      makeCategory({
        id: '01935f3d-0000-7000-8000-000000000001',
        slug: 'flower',
        displayName: 'Flower',
        displayOrder: 0,
        iconKey: 'icons/flower.png',
      }),
    ]);

    const result = await service.list();

    expect(result).toEqual([
      {
        id: '01935f3d-0000-7000-8000-000000000001',
        slug: 'flower',
        displayName: 'Flower',
        parentId: null,
        displayOrder: 0,
        iconKey: 'icons/flower.png',
      },
    ]);
  });

  it('surfaces parentId for nested subcategories', async () => {
    const { service, repo } = makeRig();
    repo.seed([
      makeCategory({
        id: '01935f3d-0000-7000-8000-00000000000a',
        slug: 'vape-cart',
        displayName: 'Vape carts',
        parentId: '01935f3d-0000-7000-8000-000000000005',
        displayOrder: 2,
      }),
    ]);

    const [child] = await service.list();

    expect(child?.parentId).toBe('01935f3d-0000-7000-8000-000000000005');
  });

  it('returns an empty array when the catalog has no categories', async () => {
    const { service } = makeRig();
    const result = await service.list();
    expect(result).toEqual([]);
  });

  it('preserves the repository order (no re-sort)', async () => {
    const { service, repo } = makeRig();
    // Repository returns rows in display_order; service must not reorder.
    repo.seed([
      makeCategory({ id: 'cat_a', slug: 'flower', displayOrder: 0 }),
      makeCategory({ id: 'cat_b', slug: 'edibles', displayOrder: 1 }),
      makeCategory({ id: 'cat_c', slug: 'concentrate', displayOrder: 2 }),
    ]);

    const result = await service.list();

    expect(result.map((c) => c.slug)).toEqual(['flower', 'edibles', 'concentrate']);
  });
});
