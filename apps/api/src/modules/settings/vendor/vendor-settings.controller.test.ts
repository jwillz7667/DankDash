/**
 * VendorSettingsController unit tests.
 *
 * Controller owns route-param plumbing and response shape. Auth wiring
 * (VendorContextGuard + RolesGuard) is verified at the module composition
 * level; here we just exercise that the controller threads ctx + body to
 * the service untouched.
 */
import { describe, expect, it } from 'vitest';
import { VendorSettingsController } from './vendor-settings.controller.js';
import type { PatchVendorSettingsRequest, VendorSettingsResponse } from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { VendorSettingsService } from './vendor-settings.service.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

const RESPONSE: VendorSettingsResponse = {
  id: CTX.dispensaryId,
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
  logoImageKey: 'brands/north-star/logo.png',
  heroImageKey: 'brands/north-star/hero.png',
  brandColorHex: '#1A4314',
  isAcceptingOrders: true,
  status: 'active',
  posProvider: 'dutchie',
  posLastSyncedAt: '2026-05-19T18:00:00.000Z',
  hasPosCredentials: true,
  metrcFacilityId: 'METRC-FAC-1',
  hasMetrcCredentials: true,
  hasAeropayAccount: true,
  createdAt: '2025-12-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
};

class FakeVendorSettingsService {
  public getCalls: VendorContext[] = [];
  public patchCalls: { ctx: VendorContext; body: PatchVendorSettingsRequest }[] = [];

  get = (ctx: VendorContext): Promise<VendorSettingsResponse> => {
    this.getCalls.push(ctx);
    return Promise.resolve(RESPONSE);
  };

  patch = (
    ctx: VendorContext,
    body: PatchVendorSettingsRequest,
  ): Promise<VendorSettingsResponse> => {
    this.patchCalls.push({ ctx, body });
    return Promise.resolve(RESPONSE);
  };
}

describe('VendorSettingsController', () => {
  it('get — forwards ctx and returns the settings response', async () => {
    const svc = new FakeVendorSettingsService();
    const controller = new VendorSettingsController(svc as unknown as VendorSettingsService);

    const result = await controller.get(CTX);

    expect(svc.getCalls).toEqual([CTX]);
    expect(result).toEqual(RESPONSE);
  });

  it('patch — forwards (ctx, body) and returns the projected settings', async () => {
    const svc = new FakeVendorSettingsService();
    const controller = new VendorSettingsController(svc as unknown as VendorSettingsService);

    const body = { isAcceptingOrders: false } as PatchVendorSettingsRequest;
    const result = await controller.patch(CTX, body);

    expect(svc.patchCalls).toEqual([{ ctx: CTX, body }]);
    expect(result).toEqual(RESPONSE);
  });
});
