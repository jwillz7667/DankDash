import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type VendorSettings } from '../../lib/api/vendor-settings.js';
import { StoreStatusCard } from './store-status-card.js';

function makeSettings(overrides: Partial<VendorSettings> = {}): VendorSettings {
  return {
    id: '01935f3d-0000-7000-8000-0000000000d1',
    legalName: 'North Loop Cannabis LLC',
    dba: 'North Loop',
    licenseNumber: 'MN-000123',
    licenseType: 'retailer',
    licenseIssuedAt: '2025-01-01',
    licenseExpiresAt: '2027-01-01',
    addressLine1: '100 N 1st St',
    addressLine2: null,
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.98] },
    deliveryPolygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-93.3, 44.9],
          [-93.2, 44.9],
          [-93.2, 45.0],
          [-93.3, 45.0],
          [-93.3, 44.9],
        ],
      ],
    },
    hours: {
      mon: { open: '08:00', close: '02:00' },
      tue: { open: '08:00', close: '02:00' },
      wed: { open: '08:00', close: '02:00' },
      thu: { open: '08:00', close: '02:00' },
      fri: { open: '08:00', close: '02:00' },
      sat: { open: '08:00', close: '02:00' },
      sun: { open: '08:00', close: '02:00' },
    },
    phone: '+16125550100',
    email: 'ops@northloop.example',
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
    hasAeropayAccount: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('StoreStatusCard', () => {
  it('shows "Open now" during posted hours and the accepting state', () => {
    // 10:00 CDT on 2026-07-02 — inside every day's 08:00→02:00 window.
    render(
      <StoreStatusCard settings={makeSettings()} now={new Date('2026-07-02T15:00:00.000Z')} />,
    );
    expect(screen.getByTestId('store-open-badge')).toHaveTextContent('Open now');
    expect(screen.getByTestId('store-accepting')).toHaveTextContent('Accepting orders');
    expect(screen.getByTestId('store-hours')).toHaveTextContent('8:00 AM – 2:00 AM');
  });

  it('shows "Closed" outside posted hours', () => {
    // 03:00 CDT — after the 02:00 close, before the 08:00 open.
    render(
      <StoreStatusCard settings={makeSettings()} now={new Date('2026-07-02T08:00:00.000Z')} />,
    );
    expect(screen.getByTestId('store-open-badge')).toHaveTextContent('Closed');
  });

  it('reflects a paused intake toggle', () => {
    render(
      <StoreStatusCard
        settings={makeSettings({ isAcceptingOrders: false })}
        now={new Date('2026-07-02T15:00:00.000Z')}
      />,
    );
    expect(screen.getByTestId('store-accepting')).toHaveTextContent('Order intake paused');
  });

  it('renders "Closed" for a day with no configured hours', () => {
    const settings = makeSettings({
      hours: { ...makeSettings().hours, thu: null },
    });
    // 2026-07-02 is Thursday.
    render(<StoreStatusCard settings={settings} now={new Date('2026-07-02T17:00:00.000Z')} />);
    expect(screen.getByTestId('store-hours')).toHaveTextContent('Closed');
  });
});
