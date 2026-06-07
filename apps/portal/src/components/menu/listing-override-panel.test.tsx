import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ListingImageUploadTicket,
  PatchVendorListingInput,
  VendorListingWithProduct,
} from '../../lib/api/vendor-listings.js';
import { ListingOverridePanel } from './listing-override-panel.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const LISTING_ID = '01935f3d-0000-7000-8000-000000000030';
const BASE_URL = 'https://cdn.dankdash.test';

function makeListing(overrides: Partial<VendorListingWithProduct> = {}): VendorListingWithProduct {
  const product: VendorListingWithProduct['product'] = {
    id: '01935f3d-0000-7000-8000-0000000000f1',
    brand: 'North Star',
    name: 'Pineapple Express',
    productType: 'flower',
    strainType: 'sativa',
    thcMgPerUnit: '875.000',
    weightGramsPerUnit: '3.500',
    imageKeys: ['products/north-star/pineapple-express/01.jpg'],
    isActive: true,
    deletedAt: null,
    ...((overrides.product ?? {}) as Partial<VendorListingWithProduct['product']>),
  };
  const base: VendorListingWithProduct = {
    id: LISTING_ID,
    dispensaryId: DISPENSARY_ID,
    productId: product.id,
    sku: 'NS-PE-3.5G',
    priceCents: 4500,
    compareAtPriceCents: null,
    quantityAvailable: 10,
    imageKeys: [],
    metrcPackageTag: null,
    lastSyncedAt: '2026-05-20T12:00:00.000Z',
    isActive: true,
    createdAt: '2026-05-18T19:00:00.000Z',
    updatedAt: '2026-05-19T19:00:00.000Z',
    product,
  };
  return { ...base, ...overrides, product };
}

/** A patch resolver that echoes the merged row, as the real action would. */
function echoingPatch(
  listing: VendorListingWithProduct,
): (id: string, patch: PatchVendorListingInput) => Promise<VendorListingWithProduct> {
  return vi
    .fn<(id: string, patch: PatchVendorListingInput) => Promise<VendorListingWithProduct>>()
    .mockImplementation((_id, patch) =>
      Promise.resolve({ ...listing, ...patch, product: listing.product }),
    );
}

function ticketFor(objectKey: string): ListingImageUploadTicket {
  return {
    uploadUrl: 'https://account.r2.cloudflarestorage.com/dankdash',
    fields: { key: objectKey, 'Content-Type': 'image/jpeg' },
    objectKey,
    expiresAt: '2026-06-07T12:05:00.000Z',
  };
}

function fileInput(): HTMLInputElement {
  return screen.getByTestId('listing-override-file-input') as HTMLInputElement;
}

describe('ListingOverridePanel — mounting', () => {
  it('renders nothing when listing is null', () => {
    const { container } = render(
      <ListingOverridePanel
        listing={null}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the product header, SKU, and the product-photos fallback badge when empty', () => {
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
      />,
    );
    expect(screen.getByText('North Star — Pineapple Express')).toBeInTheDocument();
    expect(screen.getAllByText('NS-PE-3.5G').length).toBeGreaterThan(0);
    expect(screen.getByText('Using product photos')).toBeInTheDocument();
  });
});

describe('ListingOverridePanel — images', () => {
  it('renders a custom-image gallery with composed URLs when override keys exist', () => {
    const key = `dispensaries/${DISPENSARY_ID}/listings/a.jpg`;
    render(
      <ListingOverridePanel
        listing={makeListing({ imageKeys: [key] })}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
        imageBaseUrl={BASE_URL}
      />,
    );
    expect(screen.getByText('1 custom')).toBeInTheDocument();
    const img = screen.getByTestId('listing-override-gallery').querySelector('img');
    expect(img?.getAttribute('src')).toBe(`${BASE_URL}/${key}`);
  });

  it('uploads a chosen image: presign, store, then persist the appended key', async () => {
    const listing = makeListing();
    const onPatch = echoingPatch(listing);
    const newKey = `dispensaries/${DISPENSARY_ID}/listings/new.jpg`;
    const requestImageUpload = vi.fn().mockResolvedValue(ticketFor(newKey));
    const uploadToStorage = vi.fn().mockResolvedValue(newKey);

    render(
      <ListingOverridePanel
        listing={listing}
        onClose={vi.fn()}
        onPatch={onPatch}
        requestImageUpload={requestImageUpload}
        uploadToStorage={uploadToStorage}
      />,
    );

    const file = new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(LISTING_ID, { imageKeys: [newKey] });
    });
    expect(requestImageUpload).toHaveBeenCalledWith('image/jpeg');
    expect(uploadToStorage).toHaveBeenCalledWith(ticketFor(newKey), file);
    // Gallery now reflects the new key (no CDN base → key tail rendered).
    expect(screen.getByText('new.jpg')).toBeInTheDocument();
  });

  it('rejects a non-image file without minting an upload', async () => {
    const requestImageUpload = vi.fn();
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        requestImageUpload={requestImageUpload}
      />,
    );

    const file = new File(['%PDF'], 'menu.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByTestId('listing-override-image-error')).toHaveTextContent(
      /JPEG, PNG, or WebP/i,
    );
    expect(requestImageUpload).not.toHaveBeenCalled();
  });

  it('removes an existing image by patching the filtered key set', async () => {
    const keyA = `dispensaries/${DISPENSARY_ID}/listings/a.jpg`;
    const keyB = `dispensaries/${DISPENSARY_ID}/listings/b.jpg`;
    const listing = makeListing({ imageKeys: [keyA, keyB] });
    const onPatch = echoingPatch(listing);

    render(
      <ListingOverridePanel
        listing={listing}
        onClose={vi.fn()}
        onPatch={onPatch}
        requestImageUpload={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Remove image ${keyA}` }));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(LISTING_ID, { imageKeys: [keyB] });
    });
  });

  it('blocks uploads once the 10-image limit is reached', () => {
    const keys = Array.from(
      { length: 10 },
      (_v, i) => `dispensaries/${DISPENSARY_ID}/listings/${String(i)}.jpg`,
    );
    render(
      <ListingOverridePanel
        listing={makeListing({ imageKeys: keys })}
        onClose={vi.fn()}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
      />,
    );
    expect(screen.getByTestId('listing-override-upload')).toBeDisabled();
    expect(screen.getByText(/Image limit reached/i)).toBeInTheDocument();
  });
});

describe('ListingOverridePanel — details', () => {
  it('patches only the changed detail fields', async () => {
    const listing = makeListing({ metrcPackageTag: '1A4060300002F62000000045' });
    const onPatch = echoingPatch(listing);

    render(
      <ListingOverridePanel
        listing={listing}
        onClose={vi.fn()}
        onPatch={onPatch}
        requestImageUpload={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'NS-PE-7G' } });
    fireEvent.change(screen.getByLabelText('Compare-at price'), { target: { value: '60.00' } });
    fireEvent.click(screen.getByTestId('listing-override-save'));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(LISTING_ID, {
        sku: 'NS-PE-7G',
        compareAtPriceCents: 6000,
      });
    });
  });

  it('clears the Metrc tag by sending null when the field is emptied', async () => {
    const listing = makeListing({ metrcPackageTag: '1A4060300002F62000000045' });
    const onPatch = echoingPatch(listing);

    render(
      <ListingOverridePanel
        listing={listing}
        onClose={vi.fn()}
        onPatch={onPatch}
        requestImageUpload={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Metrc package tag'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('listing-override-save'));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(LISTING_ID, { metrcPackageTag: null });
    });
  });

  it('closes without patching when nothing changed', async () => {
    const onPatch = vi.fn();
    const onClose = vi.fn();
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={onClose}
        onPatch={onPatch}
        requestImageUpload={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('listing-override-save'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('surfaces a typed error and patches nothing when compare-at is invalid', async () => {
    const onPatch = vi.fn();
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={vi.fn()}
        onPatch={onPatch}
        requestImageUpload={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Compare-at price'), { target: { value: '-5' } });
    fireEvent.click(screen.getByTestId('listing-override-save'));

    expect(await screen.findByTestId('listing-override-detail-error')).toHaveTextContent(
      /positive amount/i,
    );
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe('ListingOverridePanel — dismissal', () => {
  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={onClose}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('listing-override-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ListingOverridePanel
        listing={makeListing()}
        onClose={onClose}
        onPatch={vi.fn()}
        requestImageUpload={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
