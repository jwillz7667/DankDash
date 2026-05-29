/**
 * Unit tests for IdentityController.
 *
 * The controller is a thin pass-through; the meaningful logic lives in
 * IdentityService (covered by its own suite). What we lock down here is
 * that the /me routes thread userId from the @CurrentUser claim through to
 * the service. KycWebhookController has its own dedicated suite in
 * kyc-webhook.controller.test.ts (body/signature preconditions + dedup).
 */
import { describe, expect, it } from 'vitest';
import { IdentityController } from './identity.controller.js';
import type {
  DispensaryMembershipsResponse,
  KycStartResponse,
  MeResponse,
  UpdateMeRequestDto,
} from './dto/index.js';
import type { WebhookOutcome } from './persona/persona.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const ME: MeResponse = {
  id: USER.userId,
  email: 'jane@example.com',
  phone: '+16125550100',
  firstName: 'Jane',
  lastName: 'Doe',
  role: 'customer',
  status: 'pending_kyc',
  kycVerified: false,
  kycVerifiedAt: null,
  mfaEnabled: false,
  lastLoginAt: null,
  createdAt: '2026-05-01T00:00:00.000+00:00',
};

class FakeIdentityService {
  readonly calls = {
    getMe: [] as string[],
    updateMe: [] as Array<{ userId: string; patch: UpdateMeRequestDto }>,
    startKyc: [] as string[],
    applyKycOutcome: [] as WebhookOutcome[],
    listDispensaries: [] as string[],
  };

  nextDispensaries: DispensaryMembershipsResponse = {
    memberships: [
      {
        id: '01935f3d-0000-7000-8000-0000000000d1',
        displayName: 'North Loop',
        staffRole: 'manager',
        acceptedAt: '2026-04-02T00:00:00.000+00:00',
        joinedAt: '2026-04-02T00:00:00.000+00:00',
      },
    ],
  };

  getMe = (userId: string): Promise<MeResponse> => {
    this.calls.getMe.push(userId);
    return Promise.resolve(ME);
  };

  updateMe = (userId: string, patch: UpdateMeRequestDto): Promise<MeResponse> => {
    this.calls.updateMe.push({ userId, patch });
    // Spread conditionally so `firstName: undefined` from a .partial() DTO
    // doesn't override MeResponse's `string | null` shape — exactOptionalPropertyTypes
    // rejects `undefined` from a non-optional `string | null` slot.
    return Promise.resolve({
      ...ME,
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
    });
  };

  startKyc = (userId: string): Promise<KycStartResponse> => {
    this.calls.startKyc.push(userId);
    return Promise.resolve({
      inquiryId: 'inq_test_123',
      inquiryUrl: 'https://withpersona.com/verify?inquiry-id=inq_test_123',
    });
  };

  applyKycOutcome = (outcome: WebhookOutcome): Promise<void> => {
    this.calls.applyKycOutcome.push(outcome);
    return Promise.resolve();
  };

  listDispensaries = (userId: string): Promise<DispensaryMembershipsResponse> => {
    this.calls.listDispensaries.push(userId);
    return Promise.resolve(this.nextDispensaries);
  };
}

describe('IdentityController', () => {
  it('getMe pulls userId from the @CurrentUser claim', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);

    const res = await controller.getMe(USER);

    expect(res).toEqual(ME);
    expect(svc.calls.getMe).toEqual([USER.userId]);
  });

  it('updateMe forwards both the userId and the patch body', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);
    const patch: UpdateMeRequestDto = { firstName: 'Janet', lastName: 'Smith' };

    const res = await controller.updateMe(USER, patch);

    expect(res.firstName).toBe('Janet');
    expect(res.lastName).toBe('Smith');
    expect(svc.calls.updateMe).toEqual([{ userId: USER.userId, patch }]);
  });

  it('startKyc returns the hosted-flow URL for the iOS Safari hand-off', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);

    const res = await controller.startKyc(USER);

    expect(res.inquiryUrl).toContain('withpersona.com');
    expect(svc.calls.startKyc).toEqual([USER.userId]);
  });

  it('listDispensaries forwards the authenticated userId to the service', async () => {
    const svc = new FakeIdentityService();
    const controller = new IdentityController(svc as unknown as never);

    const res = await controller.listDispensaries(USER);

    expect(res.memberships).toHaveLength(1);
    expect(res.memberships[0]?.displayName).toBe('North Loop');
    expect(svc.calls.listDispensaries).toEqual([USER.userId]);
  });
});
