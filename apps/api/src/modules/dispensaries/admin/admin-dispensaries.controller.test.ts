/**
 * Unit tests for AdminDispensariesController.
 *
 * The controller is a thin pass-through to AdminDispensariesService; what
 * it does own is the route-param plumbing and the response shape (each
 * mutator returns a single DispensaryResponse, not an envelope). These
 * tests confirm forwarding and shape — guard wiring (RolesGuard + global
 * JwtAuthGuard) is verified at the module composition level.
 */
import { describe, expect, it } from 'vitest';
import { AdminDispensariesController } from './admin-dispensaries.controller.js';
import type { AdminDispensariesService } from './admin-dispensaries.service.js';
import type { DispensaryResponse } from '../dto/index.js';
import type { CreateDispensaryRequest, PatchDispensaryRequest } from './dto/index.js';

const DISPENSARY: DispensaryResponse = {
  id: '01935f3d-0000-7000-8000-000000000001',
  legalName: 'North Star Cannabis Co.',
  dba: null,
  licenseNumber: 'OCM-12345',
  licenseType: 'retailer',
  addressLine1: '100 Main St',
  addressLine2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  location: { type: 'Point', coordinates: [-93.27, 44.97] },
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
    mon: { open: '09:00', close: '22:00' },
    tue: { open: '09:00', close: '22:00' },
    wed: { open: '09:00', close: '22:00' },
    thu: { open: '09:00', close: '22:00' },
    fri: { open: '09:00', close: '22:00' },
    sat: { open: '10:00', close: '22:00' },
    sun: null,
  },
  phone: null,
  email: null,
  logoImageKey: null,
  heroImageKey: null,
  brandColorHex: null,
  isAcceptingOrders: false,
  isOpenNow: true,
  opensAt: null,
  ratingAvg: null,
  ratingCount: 0,
  status: 'onboarding',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

class FakeAdminService {
  public createCalls: CreateDispensaryRequest[] = [];
  public patchCalls: { id: string; body: PatchDispensaryRequest }[] = [];
  public activateCalls: string[] = [];
  public suspendCalls: string[] = [];

  create = (body: CreateDispensaryRequest): Promise<DispensaryResponse> => {
    this.createCalls.push(body);
    return Promise.resolve(DISPENSARY);
  };
  patch = (id: string, body: PatchDispensaryRequest): Promise<DispensaryResponse> => {
    this.patchCalls.push({ id, body });
    return Promise.resolve({ ...DISPENSARY, legalName: body.legalName ?? DISPENSARY.legalName });
  };
  activate = (id: string): Promise<DispensaryResponse> => {
    this.activateCalls.push(id);
    return Promise.resolve({ ...DISPENSARY, status: 'active' });
  };
  suspend = (id: string): Promise<DispensaryResponse> => {
    this.suspendCalls.push(id);
    return Promise.resolve({ ...DISPENSARY, status: 'paused' });
  };
}

function makeBody(): CreateDispensaryRequest {
  return {
    legalName: 'North Star Cannabis Co.',
    licenseNumber: 'OCM-12345',
    licenseType: 'retailer',
    licenseIssuedAt: '2024-01-01',
    licenseExpiresAt: '2028-01-01',
    addressLine1: '100 Main St',
    city: 'Minneapolis',
    region: 'MN',
    postalCode: '55401',
    location: { type: 'Point', coordinates: [-93.27, 44.97] },
    deliveryPolygon: DISPENSARY.deliveryPolygon,
    hours: DISPENSARY.hours,
  };
}

describe('AdminDispensariesController.create', () => {
  it('forwards the body and returns a single DispensaryResponse (no envelope)', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDispensariesController(svc as unknown as AdminDispensariesService);

    const body = makeBody();
    const res = await controller.create(body);

    expect(svc.createCalls).toEqual([body]);
    expect(res).toEqual(DISPENSARY);
  });
});

describe('AdminDispensariesController.patch', () => {
  it('forwards the route param and body verbatim', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDispensariesController(svc as unknown as AdminDispensariesService);

    const res = await controller.patch('01935f3d-0000-7000-8000-000000000001', {
      legalName: 'Renamed Co.',
    });

    expect(svc.patchCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-000000000001', body: { legalName: 'Renamed Co.' } },
    ]);
    expect(res.legalName).toBe('Renamed Co.');
  });
});

describe('AdminDispensariesController.activate', () => {
  it('forwards the route param and returns the activated row', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDispensariesController(svc as unknown as AdminDispensariesService);

    const res = await controller.activate('01935f3d-0000-7000-8000-000000000001');

    expect(svc.activateCalls).toEqual(['01935f3d-0000-7000-8000-000000000001']);
    expect(res.status).toBe('active');
  });
});

describe('AdminDispensariesController.suspend', () => {
  it('forwards the route param and returns the suspended row', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDispensariesController(svc as unknown as AdminDispensariesService);

    const res = await controller.suspend('01935f3d-0000-7000-8000-000000000001');

    expect(svc.suspendCalls).toEqual(['01935f3d-0000-7000-8000-000000000001']);
    expect(res.status).toBe('paused');
  });
});
