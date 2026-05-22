/**
 * Unit tests for AdminDriversController.
 *
 * The controller is a thin pass-through to AdminDriversService; what it
 * owns is the route-param plumbing and the response shape (each mutator
 * returns a single DriverResponse, not an envelope). These tests confirm
 * forwarding and shape — guard wiring (RolesGuard + global JwtAuthGuard)
 * is verified at the module composition level.
 */
import { describe, expect, it } from 'vitest';
import { AdminDriversController } from './admin-drivers.controller.js';
import type { AdminDriversService } from './admin-drivers.service.js';
import type { CreateDriverRequest, PatchDriverRequest } from './dto/index.js';
import type { DriverResponse } from '../dto/index.js';

const DRIVER: DriverResponse = {
  id: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  vehicleMake: null,
  vehicleModel: null,
  vehicleYear: null,
  vehiclePlate: null,
  vehicleColor: null,
  insuranceDocKey: null,
  insuranceExpiresAt: null,
  backgroundCheckPassedAt: null,
  backgroundCheckProviderRef: null,
  currentStatus: 'offline',
  lastStatusChangeAt: '2026-05-18T19:00:00.000Z',
  currentLocation: null,
  currentLocationUpdatedAt: null,
  currentOrderId: null,
  ratingAvg: null,
  ratingCount: 0,
  totalDeliveries: 0,
  createdAt: '2026-05-18T19:00:00.000Z',
  updatedAt: '2026-05-18T19:00:00.000Z',
};

class FakeAdminService {
  public createCalls: CreateDriverRequest[] = [];
  public patchCalls: { id: string; body: PatchDriverRequest }[] = [];

  create = (body: CreateDriverRequest): Promise<DriverResponse> => {
    this.createCalls.push(body);
    return Promise.resolve(DRIVER);
  };
  patch = (id: string, body: PatchDriverRequest): Promise<DriverResponse> => {
    this.patchCalls.push({ id, body });
    return Promise.resolve({ ...DRIVER, vehicleColor: body.vehicleColor ?? DRIVER.vehicleColor });
  };
}

function makeBody(): CreateDriverRequest {
  return {
    userId: '01935f3d-0000-7000-8000-0000000000a1',
    licenseNumber: 'DL-12345',
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehicleYear: 2023,
    vehiclePlate: 'ABC-1234',
    vehicleColor: 'white',
  };
}

describe('AdminDriversController.create', () => {
  it('forwards the body and returns a single DriverResponse (no envelope)', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDriversController(svc as unknown as AdminDriversService);

    const body = makeBody();
    const res = await controller.create(body);

    expect(svc.createCalls).toEqual([body]);
    expect(res).toEqual(DRIVER);
  });
});

describe('AdminDriversController.patch', () => {
  it('forwards the route param and body verbatim', async () => {
    const svc = new FakeAdminService();
    const controller = new AdminDriversController(svc as unknown as AdminDriversService);

    const res = await controller.patch('01935f3d-0000-7000-8000-0000000000d1', {
      vehicleColor: 'red',
    });

    expect(svc.patchCalls).toEqual([
      { id: '01935f3d-0000-7000-8000-0000000000d1', body: { vehicleColor: 'red' } },
    ]);
    expect(res.vehicleColor).toBe('red');
  });
});
