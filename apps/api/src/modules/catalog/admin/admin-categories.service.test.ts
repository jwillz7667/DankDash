/**
 * Unit tests for AdminCategoriesService.
 *
 * Behaviours pinned:
 *   - create() forwards required fields, defaults optional fields to null,
 *     returns the inflated CategoryResponse projection (same shape the
 *     public read endpoint serves).
 *   - Duplicate slug → ConflictError (pre-flight unique check).
 *   - Unknown parentId → ValidationError (pre-flight FK check).
 *   - displayOrder defaulting is left to the DB (omitted from the create
 *     input when the caller omits it).
 */
import assert from 'node:assert/strict';
import { ConflictError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { AdminCategoriesService } from './admin-categories.service.js';
import type { CreateCategoryRequest } from './dto/index.js';
import type {
  NewProductCategory,
  ProductCategoriesRepository,
  ProductCategory,
} from '@dankdash/db';

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

class FakeCategoriesRepo implements Pick<
  ProductCategoriesRepository,
  'findById' | 'findBySlug' | 'create'
> {
  public rows = new Map<string, ProductCategory>();
  public bySlug = new Map<string, ProductCategory>();
  public createCalls: (Omit<NewProductCategory, 'id'> & { id?: string })[] = [];

  seed(c: ProductCategory): void {
    this.rows.set(c.id, c);
    this.bySlug.set(c.slug, c);
  }

  findById(id: string): Promise<ProductCategory | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findBySlug(slug: string): Promise<ProductCategory | null> {
    return Promise.resolve(this.bySlug.get(slug) ?? null);
  }

  create(input: Omit<NewProductCategory, 'id'> & { id?: string }): Promise<ProductCategory> {
    this.createCalls.push(input);
    const row: ProductCategory = {
      id: input.id ?? '01935f3d-0000-7000-8000-0000000000ab',
      slug: input.slug,
      displayName: input.displayName,
      parentId: input.parentId ?? null,
      displayOrder: input.displayOrder ?? 0,
      iconKey: input.iconKey ?? null,
    };
    this.rows.set(row.id, row);
    this.bySlug.set(row.slug, row);
    return Promise.resolve(row);
  }
}

function makeRig(): {
  service: AdminCategoriesService;
  repo: FakeCategoriesRepo;
} {
  const repo = new FakeCategoriesRepo();
  const service = new AdminCategoriesService(repo as unknown as ProductCategoriesRepository);
  return { service, repo };
}

function makeBody(overrides: Partial<CreateCategoryRequest> = {}): CreateCategoryRequest {
  return {
    slug: 'edibles',
    displayName: 'Edibles',
    ...overrides,
  };
}

describe('AdminCategoriesService.create', () => {
  it('forwards required fields and defaults optional fields to null', async () => {
    const rig = makeRig();

    const res = await rig.service.create(makeBody());

    expect(rig.repo.createCalls).toHaveLength(1);
    const input = rig.repo.createCalls[0];
    assert(input !== undefined, 'expected create call');
    expect(input.slug).toBe('edibles');
    expect(input.displayName).toBe('Edibles');
    expect(input.parentId).toBeNull();
    expect(input.iconKey).toBeNull();
    // displayOrder omitted so the DB default fires.
    expect((input as { displayOrder?: unknown }).displayOrder).toBeUndefined();
    expect(res.slug).toBe('edibles');
    expect(res.parentId).toBeNull();
    expect(res.displayOrder).toBe(0);
  });

  it('forwards explicit displayOrder when present', async () => {
    const rig = makeRig();
    await rig.service.create(makeBody({ displayOrder: 5 }));
    expect(rig.repo.createCalls[0]?.displayOrder).toBe(5);
  });

  it('passes parentId through when it references an existing category', async () => {
    const rig = makeRig();
    const parent = makeCategory({
      id: '01935f3d-0000-7000-8000-000000000010',
      slug: 'plants',
      displayName: 'Plants',
    });
    rig.repo.seed(parent);

    await rig.service.create(makeBody({ slug: 'vape-cart', parentId: parent.id }));

    expect(rig.repo.createCalls[0]?.parentId).toBe(parent.id);
  });

  it('throws ConflictError on duplicate slug (pre-flight)', async () => {
    const rig = makeRig();
    rig.repo.seed(makeCategory({ slug: 'edibles' }));

    await expect(rig.service.create(makeBody({ slug: 'edibles' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(rig.repo.createCalls).toEqual([]);
  });

  it('throws ValidationError when parentId references a non-existent category', async () => {
    const rig = makeRig();

    await expect(
      rig.service.create(makeBody({ parentId: '01935f3d-0000-7000-8000-0000000000ff' })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(rig.repo.createCalls).toEqual([]);
  });

  it('treats explicit-null parentId as a top-level category (no FK check)', async () => {
    const rig = makeRig();

    await rig.service.create(makeBody({ parentId: null }));

    expect(rig.repo.createCalls[0]?.parentId).toBeNull();
  });
});
