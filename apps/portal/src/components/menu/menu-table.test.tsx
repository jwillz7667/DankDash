import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  PatchVendorListingInput,
  SyncVendorListingsResult,
  VendorListing,
  VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import { type VendorListingActions } from '../../lib/listings/listing-actions.js';
import { MenuTable } from './menu-table.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';

function makeListing(overrides: Partial<VendorListingWithProduct> = {}): VendorListingWithProduct {
  const product: VendorListingWithProduct['product'] = {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    brand: 'North Star',
    name: 'Pineapple Express',
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
    dispensaryId: DISPENSARY_ID,
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

function makeActions(overrides: Partial<VendorListingActions> = {}): VendorListingActions {
  return {
    list: overrides.list ?? (() => Promise.resolve([])),
    patch: overrides.patch ?? (() => Promise.reject(new Error('patch not stubbed'))),
    remove: overrides.remove ?? (() => Promise.resolve()),
    sync:
      overrides.sync ??
      (() =>
        Promise.resolve<SyncVendorListingsResult>({ updated: 0, syncedAt: NOW.toISOString() })),
  };
}

describe('MenuTable rendering', () => {
  it('renders one row per listing, sorted updated-then-created desc', () => {
    const a = makeListing({
      id: '01935f3d-0000-7000-8000-000000000031',
      sku: 'A',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });
    const b = makeListing({
      id: '01935f3d-0000-7000-8000-000000000032',
      sku: 'B',
      updatedAt: '2026-05-19T00:00:00.000Z',
    });
    render(<MenuTable initialListings={[a, b]} actions={makeActions()} nowFactory={() => NOW} />);
    const rows = screen.getAllByTestId('menu-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-listing-id', b.id);
    expect(rows[1]).toHaveAttribute('data-listing-id', a.id);
  });

  it('shows an empty state when no listings are seeded', () => {
    render(<MenuTable initialListings={[]} actions={makeActions()} nowFactory={() => NOW} />);
    expect(screen.getByText(/No listings yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('menu-table')).not.toBeInTheDocument();
  });

  it('filters the table by sku, brand, or product name', () => {
    const og = makeListing({
      id: '01935f3d-0000-7000-8000-000000000033',
      sku: 'OG-1G',
      product: {
        id: 'p-og',
        brand: 'Goodfellas',
        name: 'OG Kush',
        productType: 'flower',
        strainType: 'indica',
        thcMgPerUnit: '250.000',
        weightGramsPerUnit: '1.000',
        imageKeys: [],
        isActive: true,
        deletedAt: null,
      },
    });
    const pe = makeListing({
      id: '01935f3d-0000-7000-8000-000000000034',
      sku: 'PE-3.5',
    });
    render(<MenuTable initialListings={[og, pe]} actions={makeActions()} nowFactory={() => NOW} />);
    fireEvent.change(screen.getByPlaceholderText(/Search SKU/i), {
      target: { value: 'Goodfellas' },
    });
    expect(screen.getByText(/Goodfellas — OG Kush/)).toBeInTheDocument();
    expect(screen.queryByText(/North Star — Pineapple Express/)).not.toBeInTheDocument();
  });
});

describe('MenuTable sync banner derivation', () => {
  it('reports "Never synced" when any active listing has lastSyncedAt = null', () => {
    const a = makeListing({
      id: '01935f3d-0000-7000-8000-000000000031',
      sku: 'A',
      lastSyncedAt: NOW.toISOString(),
    });
    const b = makeListing({
      id: '01935f3d-0000-7000-8000-000000000032',
      sku: 'B',
      isActive: true,
      lastSyncedAt: null,
    });
    render(<MenuTable initialListings={[a, b]} actions={makeActions()} nowFactory={() => NOW} />);
    const banner = screen.getByTestId('sync-banner');
    expect(banner.textContent ?? '').toContain('Never synced');
  });

  it('ignores inactive listings when finding the oldest sync timestamp', () => {
    const recent = makeListing({
      id: '01935f3d-0000-7000-8000-000000000031',
      isActive: true,
      lastSyncedAt: NOW.toISOString(),
    });
    const inactive = makeListing({
      id: '01935f3d-0000-7000-8000-000000000032',
      isActive: false,
      lastSyncedAt: null,
    });
    render(
      <MenuTable
        initialListings={[recent, inactive]}
        actions={makeActions()}
        nowFactory={() => NOW}
      />,
    );
    // Active row is fresh -> success badge
    expect(screen.getByLabelText('sync success')).toBeInTheDocument();
  });
});

describe('MenuTable patch + sync flow', () => {
  it('merges the patched listing back over the local row and floats it to the top', async () => {
    const a = makeListing({
      id: '01935f3d-0000-7000-8000-000000000031',
      sku: 'A',
      priceCents: 4500,
      updatedAt: '2026-05-19T00:00:00.000Z',
    });
    const b = makeListing({
      id: '01935f3d-0000-7000-8000-000000000032',
      sku: 'B',
      updatedAt: '2026-05-15T00:00:00.000Z',
    });
    const patched: VendorListing = {
      ...a,
      priceCents: 5000,
      updatedAt: '2026-05-19T20:00:00.000Z',
    };
    const patch = vi
      .fn<(listingId: string, patch: PatchVendorListingInput) => Promise<VendorListing>>()
      .mockResolvedValue(patched);
    render(
      <MenuTable
        initialListings={[b, a]}
        actions={makeActions({ patch })}
        nowFactory={() => NOW}
      />,
    );

    // Edit price on row A
    const priceTriggers = screen.getAllByLabelText(/Edit price, current value \$45\.00/);
    const firstTrigger = priceTriggers[0];
    if (!firstTrigger) throw new Error('No price trigger rendered');
    fireEvent.click(firstTrigger);
    const input = await screen.findByLabelText('Edit price');
    fireEvent.change(input, { target: { value: '50.00' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(a.id, { priceCents: 5000 });
    });
    const rows = screen.getAllByTestId('menu-row');
    expect(rows[0]).toHaveAttribute('data-listing-id', a.id);
  });

  it('after a successful sync, re-fetches the listings via actions.list', async () => {
    const initial = makeListing();
    const refreshed = [
      { ...initial, lastSyncedAt: new Date(NOW.getTime() + 60_000).toISOString() },
    ];
    const list = vi
      .fn<() => Promise<readonly VendorListingWithProduct[]>>()
      .mockResolvedValue(refreshed);
    const sync = vi
      .fn<() => Promise<SyncVendorListingsResult>>()
      .mockResolvedValue({ updated: 1, syncedAt: new Date(NOW.getTime() + 60_000).toISOString() });
    render(
      <MenuTable
        initialListings={[initial]}
        actions={makeActions({ list, sync })}
        nowFactory={() => NOW}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Sync menu with POS/i }));

    await waitFor(() => {
      expect(sync).toHaveBeenCalled();
      expect(list).toHaveBeenCalled();
    });
  });
});
