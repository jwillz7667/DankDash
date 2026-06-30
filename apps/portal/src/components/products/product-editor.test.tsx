import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductEditor } from './product-editor.js';
import type { ImageUploadTicket } from '../../lib/api/image-uploads.js';
import type {
  CreateVendorProductInput,
  ProductCategory,
  VendorProduct,
} from '../../lib/api/vendor-products.js';

const CATEGORIES: readonly ProductCategory[] = [
  { id: 'cat-flower', slug: 'flower', displayName: 'Flower', parentId: null, displayOrder: 0 },
  { id: 'cat-bev', slug: 'beverage', displayName: 'Beverage', parentId: null, displayOrder: 1 },
];

function makeProduct(overrides: Partial<VendorProduct> = {}): VendorProduct {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    categoryId: 'cat-flower',
    brand: 'Boreal Gold',
    name: 'House Blend',
    description: null,
    productType: 'flower',
    strainType: 'hybrid',
    thcMgPerUnit: '700.000',
    cbdMgPerUnit: '0',
    weightGramsPerUnit: '3.500',
    servingCount: null,
    thcMgPerServing: null,
    imageKeys: [],
    effectsTags: [],
    flavorTags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeActions(create = vi.fn(async (i: CreateVendorProductInput) => makeProduct(i as Partial<VendorProduct>))) {
  return {
    create,
    patch: vi.fn(async () => makeProduct()),
    requestImageUpload: vi.fn(
      async (): Promise<ImageUploadTicket> => ({
        uploadUrl: 'https://r2',
        fields: {},
        objectKey: 'k',
        expiresAt: '2026-06-29T00:00:00.000Z',
      }),
    ),
  };
}

describe('ProductEditor — create', () => {
  it('submits a full create payload with parsed tags and decimal strings', async () => {
    const actions = makeActions();
    const onSaved = vi.fn();
    render(
      <ProductEditor
        product={null}
        categories={CATEGORIES}
        onClose={vi.fn()}
        onSaved={onSaved}
        actions={actions}
      />,
    );

    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'Boreal Gold' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sunrise 3.5g' } });
    fireEvent.change(screen.getByLabelText('THC (mg/unit)'), { target: { value: '720.000' } });
    fireEvent.change(screen.getByLabelText('Effects (comma-separated)'), {
      target: { value: 'relaxed, happy' },
    });
    fireEvent.click(screen.getByTestId('product-editor-save'));

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledTimes(1);
    });
    const payload = actions.create.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      brand: 'Boreal Gold',
      name: 'Sunrise 3.5g',
      categoryId: 'cat-flower',
      productType: 'flower',
      thcMgPerUnit: '720.000',
      effectsTags: ['relaxed', 'happy'],
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('blocks an empty brand without calling the API', async () => {
    const actions = makeActions();
    render(
      <ProductEditor
        product={null}
        categories={CATEGORIES}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('THC (mg/unit)'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('product-editor-save'));

    expect(await screen.findByTestId('product-editor-error')).toHaveTextContent(/Brand is required/i);
    expect(actions.create).not.toHaveBeenCalled();
  });

  it('blocks a beverage over the 10mg/serving cap client-side', async () => {
    const actions = makeActions();
    render(
      <ProductEditor
        product={null}
        categories={CATEGORIES}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'Fizz Co' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cola 12oz' } });
    fireEvent.change(screen.getByLabelText('THC (mg/unit)'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('product-editor-type'), { target: { value: 'beverage' } });
    fireEvent.change(screen.getByLabelText('THC (mg/serving)'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('product-editor-save'));

    expect(await screen.findByTestId('product-editor-error')).toHaveTextContent(/10mg THC per serving/i);
    expect(actions.create).not.toHaveBeenCalled();
  });
});

describe('ProductEditor — edit', () => {
  it('seeds fields from the product and patches on save', async () => {
    const actions = makeActions();
    const product = makeProduct({ name: 'House Blend', thcMgPerUnit: '700.000' });
    render(
      <ProductEditor
        product={product}
        categories={CATEGORIES}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        actions={actions}
      />,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('House Blend');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'House Blend v2' } });
    fireEvent.click(screen.getByTestId('product-editor-save'));

    await waitFor(() => {
      expect(actions.patch).toHaveBeenCalledWith(product.id, expect.objectContaining({ name: 'House Blend v2' }));
    });
  });
});
