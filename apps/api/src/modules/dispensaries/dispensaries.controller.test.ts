/**
 * Unit tests for DispensariesController.
 *
 * The controller is a thin pass-through to DispensariesService; the meaningful
 * surface it owns is the response envelope on the list endpoint
 * (`{ dispensaries: [...] }`) so future cache hints can be added without a
 * breaking parse change on the client.
 */
import { describe, expect, it } from 'vitest';
import { DispensariesController } from './dispensaries.controller.js';
import type { DispensariesService } from './dispensaries.service.js';
import type { DispensaryResponse, ListDispensariesQuery, MenuResponse } from './dto/index.js';

const DISPENSARY: DispensaryResponse = {
  id: '01935f3d-0000-7000-8000-000000000001',
  legalName: 'North Star Cannabis Co.',
  dba: 'North Star',
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
    mon: { open: '10:00', close: '22:00' },
    tue: { open: '10:00', close: '22:00' },
    wed: { open: '10:00', close: '22:00' },
    thu: { open: '10:00', close: '22:00' },
    fri: { open: '10:00', close: '22:00' },
    sat: { open: '10:00', close: '22:00' },
    sun: null,
  },
  phone: null,
  email: null,
  logoImageKey: null,
  heroImageKey: null,
  brandColorHex: null,
  isAcceptingOrders: true,
  isOpenNow: true,
  opensAt: null,
  ratingAvg: null,
  ratingCount: 0,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const MENU: MenuResponse = {
  dispensaryId: '01935f3d-0000-7000-8000-000000000001',
  items: [],
};

class FakeDispensariesService {
  public listCalls: ListDispensariesQuery[] = [];
  public getByIdCalls: string[] = [];
  public getMenuCalls: string[] = [];
  public nextList: readonly DispensaryResponse[] = [];

  list = (q: ListDispensariesQuery): Promise<readonly DispensaryResponse[]> => {
    this.listCalls.push(q);
    return Promise.resolve(this.nextList);
  };

  getById = (id: string): Promise<DispensaryResponse> => {
    this.getByIdCalls.push(id);
    return Promise.resolve(DISPENSARY);
  };

  getMenu = (id: string): Promise<MenuResponse> => {
    this.getMenuCalls.push(id);
    return Promise.resolve(MENU);
  };
}

describe('DispensariesController.list', () => {
  it('forwards the query and wraps the result in the `{ dispensaries: [...] }` envelope', async () => {
    const svc = new FakeDispensariesService();
    svc.nextList = [DISPENSARY];
    const controller = new DispensariesController(svc as unknown as DispensariesService);

    const res = await controller.list({ lat: 44.97, lng: -93.27 });

    expect(res).toEqual({ dispensaries: [DISPENSARY] });
    expect(svc.listCalls).toEqual([{ lat: 44.97, lng: -93.27 }]);
  });

  it('returns an empty envelope when no dispensaries match', async () => {
    const svc = new FakeDispensariesService();
    const controller = new DispensariesController(svc as unknown as DispensariesService);

    const res = await controller.list({});

    expect(res).toEqual({ dispensaries: [] });
  });
});

describe('DispensariesController.getById', () => {
  it('forwards the route param to DispensariesService.getById', async () => {
    const svc = new FakeDispensariesService();
    const controller = new DispensariesController(svc as unknown as DispensariesService);

    const res = await controller.getById('01935f3d-0000-7000-8000-000000000001');

    expect(res).toEqual(DISPENSARY);
    expect(svc.getByIdCalls).toEqual(['01935f3d-0000-7000-8000-000000000001']);
  });
});

describe('DispensariesController.getMenu', () => {
  it('forwards the route param to DispensariesService.getMenu', async () => {
    const svc = new FakeDispensariesService();
    const controller = new DispensariesController(svc as unknown as DispensariesService);

    const res = await controller.getMenu('01935f3d-0000-7000-8000-000000000001');

    expect(res).toEqual(MENU);
    expect(svc.getMenuCalls).toEqual(['01935f3d-0000-7000-8000-000000000001']);
  });
});
