import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client.js';
import type { PatchVendorSettingsInput, VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';
import { StoreSettingsClient } from './store-settings-client.js';

const BASE: VendorSettings = {
  id: '01935f3d-0000-7000-8000-0000000000d1',
  legalName: 'North Star LLC',
  dba: null,
  licenseNumber: 'MN-2025-0001',
  licenseType: 'retailer',
  licenseIssuedAt: '2025-01-01',
  licenseExpiresAt: '2027-01-01',
  addressLine1: '1 Main St',
  addressLine2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.265, 44.978] },
  deliveryPolygon: {
    type: 'Polygon',
    coordinates: [
      [
        [-93.3, 44.95],
        [-93.2, 44.95],
        [-93.2, 45.0],
        [-93.3, 45.0],
        [-93.3, 44.95],
      ],
    ],
  },
  hours: {
    mon: { open: '08:00', close: '22:00' },
    tue: { open: '08:00', close: '22:00' },
    wed: { open: '08:00', close: '22:00' },
    thu: { open: '08:00', close: '22:00' },
    fri: { open: '08:00', close: '22:00' },
    sat: { open: '10:00', close: '22:00' },
    sun: null,
  },
  phone: '+1-612-555-0100',
  email: 'hi@northstar.example',
  logoImageKey: null,
  heroImageKey: null,
  brandColorHex: '#1A4314',
  isAcceptingOrders: true,
  status: 'active',
  posProvider: 'manual',
  posLastSyncedAt: null,
  hasPosCredentials: false,
  metrcFacilityId: null,
  hasMetrcCredentials: false,
  hasAeropayAccount: false,
  createdAt: '2025-12-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
};

function makeActions(overrides: Partial<VendorSettingsActions> = {}): VendorSettingsActions {
  return {
    get: overrides.get ?? (() => Promise.resolve(BASE)),
    patch: overrides.patch ?? (() => Promise.reject(new Error('patch not stubbed'))),
    requestImageUpload:
      overrides.requestImageUpload ??
      (() => Promise.reject(new Error('requestImageUpload not stubbed'))),
  };
}

describe('StoreSettingsClient — accepting orders', () => {
  it('shows the active state with the pause CTA when accepting', () => {
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions()} />);
    expect(screen.getByText(/Accepting orders/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause intake/i })).toBeInTheDocument();
  });

  it('shows the paused state when intake is off', () => {
    render(
      <StoreSettingsClient
        initialSettings={{ ...BASE, isAcceptingOrders: false }}
        actions={makeActions()}
      />,
    );
    expect(screen.getByRole('heading', { name: /paused/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume intake/i })).toBeInTheDocument();
  });

  it('flips the toggle and merges the server response into the snapshot', async () => {
    const patch = vi.fn<(input: PatchVendorSettingsInput) => Promise<VendorSettings>>(
      async (input) => ({ ...BASE, isAcceptingOrders: input.isAcceptingOrders ?? false }),
    );
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.click(screen.getByRole('button', { name: /pause intake/i }));
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith({ isAcceptingOrders: false });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /resume intake/i })).toBeInTheDocument();
    });
  });

  it('surfaces the 403 error without flipping the local state', async () => {
    const err = new ApiError('forbidden', 403, 'forbidden', {
      error: { code: 'forbidden', message: 'nope', details: {} },
    });
    const patch = vi.fn(() => Promise.reject(err));
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.click(screen.getByRole('button', { name: /pause intake/i }));
    await screen.findByText(/don't have permission/i);
    expect(screen.getByRole('button', { name: /pause intake/i })).toBeInTheDocument();
  });
});

describe('StoreSettingsClient — hours', () => {
  it('disables the save button until the user changes hours', () => {
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions()} />);
    expect(screen.getByRole('button', { name: /save hours/i })).toBeDisabled();
  });

  it('saves the full hours payload after a single field changes', async () => {
    const patched = { ...BASE };
    const patch = vi.fn(async () => patched);
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    const monOpen = screen.getByLabelText(/monday open time/i);
    fireEvent.change(monOpen, { target: { value: '09:00' } });
    const save = screen.getByRole('button', { name: /save hours/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith({
        hours: { ...BASE.hours, mon: { open: '09:00', close: '22:00' } },
      });
    });
  });

  it('rejects a malformed HH:MM client-side', async () => {
    const patch = vi.fn();
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.change(screen.getByLabelText(/monday open time/i), {
      target: { value: '8am' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save hours/i }));
    await screen.findByText(/Monday: use HH:MM/i);
    expect(patch).not.toHaveBeenCalled();
  });

  it('marks a day closed and saves null for it', async () => {
    const patch = vi.fn<(input: PatchVendorSettingsInput) => Promise<VendorSettings>>(
      async () => BASE,
    );
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /closed/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /save hours/i }));
    await waitFor(() => {
      expect(patch).toHaveBeenCalled();
    });
    const firstCall = patch.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0].hours?.mon).toBeNull();
  });
});

describe('StoreSettingsClient — contact', () => {
  it('sends nulls for cleared fields', async () => {
    const patch = vi.fn(async () => BASE);
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.change(screen.getByLabelText(/^phone$/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith({ phone: null, email: null });
    });
  });
});

describe('StoreSettingsClient — brand', () => {
  it('rejects an invalid hex color before sending', async () => {
    const patch = vi.fn();
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.change(screen.getByLabelText(/brand color/i), {
      target: { value: 'forest' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save color/i }));
    await screen.findByText(/must be #RRGGBB/i);
    expect(patch).not.toHaveBeenCalled();
  });

  it('sends a valid hex color through the patch action', async () => {
    const patch = vi.fn(async () => BASE);
    render(<StoreSettingsClient initialSettings={BASE} actions={makeActions({ patch })} />);
    fireEvent.change(screen.getByLabelText(/brand color/i), {
      target: { value: '#2A6D34' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save color/i }));
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith({ brandColorHex: '#2A6D34' });
    });
  });
});
