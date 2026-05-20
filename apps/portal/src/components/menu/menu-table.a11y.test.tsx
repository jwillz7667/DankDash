/**
 * axe-core a11y assertions for the menu surface — the Phase 15 DoD
 * requires zero violations on the operator-critical vendor screens.
 *
 * Coverage:
 *   - Empty menu (no listings, EmptyState renders)
 *   - Populated menu (rows + inline-edit affordances)
 *   - Inline-edit input open (price cell, form + commit/cancel buttons)
 *   - "Never synced" banner state (one active listing with `lastSyncedAt = null`)
 *
 * Each scenario wraps the surface in a `<main>` landmark so the
 * `region` rule isn't tripped by isolated component renders. Production
 * wraps the table in the dashboard shell, so the rule's intent is
 * already satisfied at the page level.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { checkA11y, expectNoA11yViolations } from '../../../test/utils/axe.js';
import type {
  SyncVendorListingsResult,
  VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import type { VendorListingActions } from '../../lib/listings/listing-actions.js';
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

function buildActions(): VendorListingActions {
  return {
    list: vi.fn(async () => []),
    patch: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    remove: vi.fn(async () => undefined),
    sync: vi.fn(
      async (): Promise<SyncVendorListingsResult> => ({
        updated: 0,
        syncedAt: NOW.toISOString(),
      }),
    ),
  };
}

describe('MenuTable — a11y', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has zero violations with an empty listings state', async () => {
    const { container } = render(
      <main>
        <MenuTable initialListings={[]} actions={buildActions()} nowFactory={() => NOW} />
      </main>,
    );
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations with multiple populated rows', async () => {
    const listings = [
      makeListing({
        id: '01935f3d-0000-7000-8000-000000000031',
        sku: 'NS-PE-3.5G',
        priceCents: 4500,
        quantityAvailable: 12,
      }),
      makeListing({
        id: '01935f3d-0000-7000-8000-000000000032',
        sku: 'GF-OG-1G',
        priceCents: 1500,
        quantityAvailable: 0,
        isActive: false,
        metrcPackageTag: '1A4FF010000022B000000023',
        product: {
          id: '01935f3d-0000-7000-8000-0000000000f2',
          brand: 'Goodfellas',
          name: 'OG Kush 1g',
          productType: 'flower',
          strainType: 'indica',
          thcMgPerUnit: '250.000',
          weightGramsPerUnit: '1.000',
          imageKeys: [],
          isActive: true,
          deletedAt: null,
        },
      }),
    ];
    const { container } = render(
      <main>
        <MenuTable initialListings={listings} actions={buildActions()} nowFactory={() => NOW} />
      </main>,
    );
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations while an inline-edit input is open', async () => {
    const { container } = render(
      <main>
        <MenuTable
          initialListings={[makeListing()]}
          actions={buildActions()}
          nowFactory={() => NOW}
        />
      </main>,
    );

    fireEvent.click(screen.getByLabelText(/Edit price, current value \$45\.00/));
    // Ensure the inline-edit input is mounted before we hand the tree to axe.
    await screen.findByLabelText('Edit price');

    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });

  it('has zero violations when the sync banner is in the "Never synced" state', async () => {
    const { container } = render(
      <main>
        <MenuTable
          initialListings={[
            makeListing({
              id: '01935f3d-0000-7000-8000-000000000031',
              lastSyncedAt: null,
            }),
          ]}
          actions={buildActions()}
          nowFactory={() => NOW}
        />
      </main>,
    );
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });
});
