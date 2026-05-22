import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VendorListingWithProduct } from '../../lib/api/vendor-listings.js';
import { MenuRow } from './menu-row.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function makeListing(overrides: Partial<VendorListingWithProduct> = {}): VendorListingWithProduct {
  const product: VendorListingWithProduct['product'] = {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    brand: 'North Star',
    name: 'Pineapple Express 3.5g',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
    imageKeys: [],
    isActive: true,
    deletedAt: null,
    ...((overrides.product ?? {}) as Partial<VendorListingWithProduct['product']>),
  };
  const base: VendorListingWithProduct = {
    id: '01935f3d-0000-7000-8000-000000000030',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
    productId: product.id,
    sku: 'NS-PE-3.5G',
    priceCents: 4500,
    compareAtPriceCents: null,
    quantityAvailable: 10,
    metrcPackageTag: null,
    lastSyncedAt: NOW.toISOString(),
    isActive: true,
    createdAt: '2026-05-18T19:00:00.000Z',
    updatedAt: '2026-05-19T19:00:00.000Z',
    product,
  };
  return { ...base, ...overrides, product };
}

function renderRow(
  overrides: Partial<VendorListingWithProduct> = {},
  onPatch?: (id: string, patch: unknown) => Promise<VendorListingWithProduct>,
) {
  const listing = makeListing(overrides);
  const handlePatch =
    onPatch ??
    vi
      .fn<(id: string, patch: unknown) => Promise<VendorListingWithProduct>>()
      .mockResolvedValue(listing);
  render(
    <table>
      <tbody>
        <MenuRow listing={listing} onPatch={handlePatch as never} now={NOW} />
      </tbody>
    </table>,
  );
  return { handlePatch, listing };
}

describe('MenuRow display', () => {
  it('shows brand, name, SKU, product type, and strain on the product cell', () => {
    renderRow();
    expect(screen.getByText(/North Star — Pineapple Express 3.5g/)).toBeInTheDocument();
    expect(screen.getByText('NS-PE-3.5G')).toBeInTheDocument();
    expect(screen.getByText('flower')).toBeInTheDocument();
    expect(screen.getByText('sativa')).toBeInTheDocument();
  });

  it('flags the row as Archived when the product is no longer in the global catalog', () => {
    renderRow({
      product: {
        id: '01935f3d-0000-7000-8000-0000000000f1',
        brand: 'North Star',
        name: 'Pineapple Express 3.5g',
        productType: 'flower',
        strainType: 'sativa',
        thcMgPerUnit: '875.000',
        weightGramsPerUnit: '3.500',
        imageKeys: [],
        isActive: false,
        deletedAt: '2026-04-01T00:00:00.000Z',
      },
    });
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('renders price formatted with $ and quantity verbatim', () => {
    renderRow({ priceCents: 1299, quantityAvailable: 42 });
    expect(screen.getByLabelText(/Edit price, current value \$12\.99/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Edit quantity available, current value 42/)).toBeInTheDocument();
  });

  it('shows the Metrc package tag when present', () => {
    renderRow({ metrcPackageTag: '1A4060300002F62000000045' });
    expect(screen.getByText('1A4060300002F62000000045')).toBeInTheDocument();
  });
});

describe('MenuRow inline price edit', () => {
  it('commits a parsed cents value to onPatch on Enter, then settles', async () => {
    const onPatch = vi
      .fn<(id: string, patch: unknown) => Promise<VendorListingWithProduct>>()
      .mockImplementation((_, p) =>
        Promise.resolve(makeListing({ priceCents: (p as { priceCents: number }).priceCents })),
      );
    const { listing } = renderRow({}, onPatch);

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    const input = await screen.findByLabelText('Edit price');
    fireEvent.change(input, { target: { value: '49.50' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(listing.id, { priceCents: 4950 });
    });
  });

  it('rejects a zero/negative/junk price with a typed message and does not call onPatch', async () => {
    const onPatch = vi.fn();
    renderRow({}, onPatch as never);

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    const input = await screen.findByLabelText('Edit price');
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/positive number/i);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('Escape cancels the edit and restores the display value', async () => {
    const onPatch = vi.fn();
    renderRow({}, onPatch as never);

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    const input = await screen.findByLabelText('Edit price');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onPatch).not.toHaveBeenCalled();
    // Edit closed -> click-to-edit button visible again
    expect(screen.getByLabelText(/Edit price, current value \$45\.00/)).toBeInTheDocument();
  });

  it('does not call onPatch when the edit ends with the same value', async () => {
    const onPatch = vi.fn();
    renderRow({ priceCents: 4500 }, onPatch as never);

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    const input = await screen.findByLabelText('Edit price');
    fireEvent.submit(input.closest('form')!);

    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe('MenuRow inline quantity edit', () => {
  it('commits a parsed integer to onPatch', async () => {
    const onPatch = vi
      .fn<(id: string, patch: unknown) => Promise<VendorListingWithProduct>>()
      .mockImplementation((_, p) =>
        Promise.resolve(
          makeListing({
            quantityAvailable: (p as { quantityAvailable: number }).quantityAvailable,
          }),
        ),
      );
    const { listing } = renderRow({ quantityAvailable: 10 }, onPatch);

    fireEvent.click(screen.getByLabelText(/Edit quantity available, current value 10/));
    const input = await screen.findByLabelText('Edit quantity available');
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(listing.id, { quantityAvailable: 25 });
    });
  });

  it('rejects fractional or non-numeric quantity', async () => {
    const onPatch = vi.fn();
    renderRow({}, onPatch as never);

    fireEvent.click(screen.getByLabelText(/Edit quantity available, current value 10/));
    const input = await screen.findByLabelText('Edit quantity available');
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/non-negative integer/i);
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe('MenuRow active toggle', () => {
  it('flips isActive on click and calls onPatch with the new value', async () => {
    const onPatch = vi
      .fn<(id: string, patch: unknown) => Promise<VendorListingWithProduct>>()
      .mockImplementation((_, p) =>
        Promise.resolve(makeListing(p as Partial<VendorListingWithProduct>)),
      );
    renderRow({ isActive: true }, onPatch);

    fireEvent.click(screen.getByRole('switch', { name: /deactivate/i }));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(expect.any(String), { isActive: false });
    });
  });

  it('inactive listing button reads "activate"', () => {
    renderRow({ isActive: false });
    expect(screen.getByRole('switch', { name: /activate/i })).toBeInTheDocument();
  });
});

describe('MenuRow error path', () => {
  it('surfaces a generic message when onPatch rejects', async () => {
    const onPatch = vi
      .fn<(id: string, patch: unknown) => Promise<VendorListingWithProduct>>()
      .mockRejectedValue(new Error('boom'));
    renderRow({}, onPatch);

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    const input = await screen.findByLabelText('Edit price');
    fireEvent.change(input, { target: { value: '50.00' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't save/i);
  });
});
