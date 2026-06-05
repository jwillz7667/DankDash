/**
 * Unit tests for DriverOnboardingController.
 *
 * The controller is a thin pass-through to DriverOnboardingService; what
 * it owns is pulling the principal's `userId` off `@CurrentUser` (never
 * trusting a body-supplied user id, unlike the admin path) and the
 * response shape. Guard wiring (global JwtAuthGuard) is verified at the
 * module-composition level.
 */
import { describe, expect, it } from 'vitest';
import { DriverOnboardingController } from './driver-onboarding.controller.js';
import type { DriverOnboardingService } from './driver-onboarding.service.js';
import type { DriverApplicationRequest, DriverApplicationResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { DriverResponse } from '../dto/index.js';

const USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
const DRIVER_ID = '01935f3d-0000-7000-8000-0000000000d1';

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-0000000000s1',
  role: 'customer',
};

const DRIVER: DriverResponse = {
  id: DRIVER_ID,
  userId: USER_ID,
  vehicleMake: 'Toyota',
  vehicleModel: 'Prius',
  vehicleYear: 2023,
  vehiclePlate: 'ABC-1234',
  vehicleColor: 'white',
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

function makeApplyBody(): DriverApplicationRequest {
  return {
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehicleYear: 2023,
    vehiclePlate: 'ABC-1234',
    vehicleColor: 'white',
    licenseNumber: 'DL-12345',
    documents: [
      { kind: 'drivers_license', storageKey: 'dl.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 },
    ],
  };
}

class FakeOnboardingService {
  public meCalls: string[] = [];
  public applyCalls: { userId: string; body: DriverApplicationRequest }[] = [];

  me = (userId: string): Promise<DriverResponse> => {
    this.meCalls.push(userId);
    return Promise.resolve(DRIVER);
  };
  apply = (userId: string, body: DriverApplicationRequest): Promise<DriverApplicationResponse> => {
    this.applyCalls.push({ userId, body });
    return Promise.resolve({ applicationId: DRIVER_ID, status: 'pending', queuePosition: null });
  };
}

describe('DriverOnboardingController.me', () => {
  it('forwards the principal userId and returns a single DriverResponse', async () => {
    const svc = new FakeOnboardingService();
    const controller = new DriverOnboardingController(svc as unknown as DriverOnboardingService);

    const res = await controller.me(PRINCIPAL);

    expect(svc.meCalls).toEqual([USER_ID]);
    expect(res).toEqual(DRIVER);
  });
});

describe('DriverOnboardingController.apply', () => {
  it('derives userId from the principal (not the body) and forwards the body', async () => {
    const svc = new FakeOnboardingService();
    const controller = new DriverOnboardingController(svc as unknown as DriverOnboardingService);

    const body = makeApplyBody();
    const res = await controller.apply(PRINCIPAL, body);

    expect(svc.applyCalls).toEqual([{ userId: USER_ID, body }]);
    expect(res).toEqual({ applicationId: DRIVER_ID, status: 'pending', queuePosition: null });
  });
});
