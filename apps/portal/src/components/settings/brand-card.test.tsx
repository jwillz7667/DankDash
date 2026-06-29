import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrandCard } from './brand-card.js';
import type { ImageUploadTicket } from '../../lib/api/image-uploads.js';
import type { PatchVendorSettingsInput, VendorSettings } from '../../lib/api/vendor-settings.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const BASE_URL = 'https://cdn.dankdash.test';

function makeSettings(overrides: Partial<VendorSettings> = {}): VendorSettings {
  const base: VendorSettings = {
    id: DISPENSARY_ID,
    legalName: 'North Star LLC',
    dba: 'North Star Cannabis',
    licenseNumber: 'MN-2025-0001',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    addressLine1: '1 Main St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.98] },
    deliveryPolygon: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    phone: null,
    email: null,
    logoImageKey: null,
    heroImageKey: null,
    brandColorHex: null,
    isAcceptingOrders: true,
    status: 'active',
    posProvider: 'manual',
    posLastSyncedAt: null,
    hasPosCredentials: false,
    metrcFacilityId: null,
    hasMetrcCredentials: false,
    hasAeropayAccount: false,
    createdAt: '2026-05-18T19:00:00.000Z',
    updatedAt: '2026-05-19T19:00:00.000Z',
  };
  return { ...base, ...overrides };
}

/** A patch resolver that echoes the merged settings, as the real action would. */
function echoingPatch(
  settings: VendorSettings,
): (patch: PatchVendorSettingsInput) => Promise<VendorSettings> {
  return vi
    .fn<(patch: PatchVendorSettingsInput) => Promise<VendorSettings>>()
    .mockImplementation((patch) => Promise.resolve({ ...settings, ...patch }));
}

function ticketFor(objectKey: string): ImageUploadTicket {
  return {
    uploadUrl: 'https://account.r2.cloudflarestorage.com/dankdash',
    fields: { key: objectKey, 'Content-Type': 'image/jpeg' },
    objectKey,
    expiresAt: '2026-06-29T12:05:00.000Z',
  };
}

interface RenderOpts {
  readonly heroImageKey?: string | null;
  readonly logoImageKey?: string | null;
  readonly brandColorHex?: string | null;
  readonly imageBaseUrl?: string;
  readonly onPatch?: (patch: PatchVendorSettingsInput) => Promise<VendorSettings>;
}

function renderCard(opts: RenderOpts = {}): {
  onPatch: (patch: PatchVendorSettingsInput) => Promise<VendorSettings>;
  onPatched: ReturnType<typeof vi.fn>;
  requestImageUpload: ReturnType<typeof vi.fn>;
  uploadToStorage: ReturnType<typeof vi.fn>;
} {
  const onPatch = opts.onPatch ?? echoingPatch(makeSettings());
  const onPatched = vi.fn();
  const requestImageUpload = vi.fn();
  const uploadToStorage = vi.fn();
  render(
    <BrandCard
      brandColorHex={opts.brandColorHex ?? null}
      logoImageKey={opts.logoImageKey ?? null}
      heroImageKey={opts.heroImageKey ?? null}
      onPatch={onPatch}
      onPatched={onPatched}
      requestImageUpload={requestImageUpload}
      imageBaseUrl={opts.imageBaseUrl}
      uploadToStorage={uploadToStorage}
    />,
  );
  return { onPatch, onPatched, requestImageUpload, uploadToStorage };
}

function heroInput(): HTMLInputElement {
  return screen.getByTestId('brand-image-input-heroImageKey') as HTMLInputElement;
}

describe('BrandCard — image fields', () => {
  it('renders an empty-state for hero and logo with no key set', () => {
    renderCard();
    expect(screen.getByTestId('brand-image-heroImageKey')).toBeInTheDocument();
    expect(screen.getByTestId('brand-image-logoImageKey')).toBeInTheDocument();
    expect(screen.getAllByText('No image yet').length).toBe(2);
    expect(screen.getByTestId('brand-image-upload-heroImageKey')).toHaveTextContent('Upload image');
  });

  it('renders a preview with a composed URL when a hero key + base are set', () => {
    const key = `dispensaries/${DISPENSARY_ID}/brand/a.jpg`;
    renderCard({ heroImageKey: key, imageBaseUrl: BASE_URL });
    const section = screen.getByTestId('brand-image-heroImageKey');
    expect(section.querySelector('img')?.getAttribute('src')).toBe(`${BASE_URL}/${key}`);
    // With a key set the button offers to replace rather than upload.
    expect(screen.getByTestId('brand-image-upload-heroImageKey')).toHaveTextContent('Replace');
  });

  it('uploads a hero image: presign, store, then persist the returned key', async () => {
    const newKey = `dispensaries/${DISPENSARY_ID}/brand/new.jpg`;
    const onPatch = echoingPatch(makeSettings());
    const requestImageUpload = vi.fn().mockResolvedValue(ticketFor(newKey));
    const uploadToStorage = vi.fn().mockResolvedValue(newKey);
    const onPatched = vi.fn();

    render(
      <BrandCard
        brandColorHex={null}
        logoImageKey={null}
        heroImageKey={null}
        onPatch={onPatch}
        onPatched={onPatched}
        requestImageUpload={requestImageUpload}
        uploadToStorage={uploadToStorage}
      />,
    );

    const file = new File(['bytes'], 'hero.jpg', { type: 'image/jpeg' });
    fireEvent.change(heroInput(), { target: { files: [file] } });

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({ heroImageKey: newKey });
    });
    expect(requestImageUpload).toHaveBeenCalledWith('image/jpeg');
    expect(uploadToStorage).toHaveBeenCalledWith(ticketFor(newKey), file);
    expect(onPatched).toHaveBeenCalledOnce();
  });

  it('rejects a non-image file without minting an upload', async () => {
    const { requestImageUpload } = renderCard();
    const file = new File(['%PDF'], 'menu.pdf', { type: 'application/pdf' });
    fireEvent.change(heroInput(), { target: { files: [file] } });

    expect(await screen.findByTestId('brand-image-error-heroImageKey')).toHaveTextContent(
      /JPEG, PNG, or WebP/i,
    );
    expect(requestImageUpload).not.toHaveBeenCalled();
  });

  it('rejects a file larger than 5 MB without minting an upload', async () => {
    const { requestImageUpload } = renderCard();
    const file = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
    fireEvent.change(heroInput(), { target: { files: [file] } });

    expect(await screen.findByTestId('brand-image-error-heroImageKey')).toHaveTextContent(
      /5 MB or smaller/i,
    );
    expect(requestImageUpload).not.toHaveBeenCalled();
  });

  it('removes the hero image by patching the key to null', async () => {
    const key = `dispensaries/${DISPENSARY_ID}/brand/a.jpg`;
    const onPatch = echoingPatch(makeSettings({ heroImageKey: key }));
    const onPatched = vi.fn();
    render(
      <BrandCard
        brandColorHex={null}
        logoImageKey={null}
        heroImageKey={key}
        onPatch={onPatch}
        onPatched={onPatched}
        requestImageUpload={vi.fn()}
        uploadToStorage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('brand-image-remove-heroImageKey'));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({ heroImageKey: null });
    });
    expect(onPatched).toHaveBeenCalledOnce();
  });
});

describe('BrandCard — color', () => {
  it('saves a valid hex color', async () => {
    const onPatch = echoingPatch(makeSettings());
    const onPatched = vi.fn();
    render(
      <BrandCard
        brandColorHex={null}
        logoImageKey={null}
        heroImageKey={null}
        onPatch={onPatch}
        onPatched={onPatched}
        requestImageUpload={vi.fn()}
        uploadToStorage={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Brand color (hex)'), { target: { value: '#1A4314' } });
    fireEvent.click(screen.getByRole('button', { name: /save color/i }));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({ brandColorHex: '#1A4314' });
    });
  });

  it('blocks an invalid hex color and patches nothing', async () => {
    const onPatch = echoingPatch(makeSettings());
    render(
      <BrandCard
        brandColorHex={null}
        logoImageKey={null}
        heroImageKey={null}
        onPatch={onPatch}
        onPatched={vi.fn()}
        requestImageUpload={vi.fn()}
        uploadToStorage={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Brand color (hex)'), { target: { value: 'not-a-hex' } });
    fireEvent.click(screen.getByRole('button', { name: /save color/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/#RRGGBB/i);
    expect(onPatch).not.toHaveBeenCalled();
  });
});
