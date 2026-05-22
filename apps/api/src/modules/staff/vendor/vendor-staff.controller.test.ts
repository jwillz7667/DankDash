/**
 * VendorStaffController unit tests.
 *
 * Controller owns route-param plumbing and response shape. Auth wiring
 * (VendorContextGuard + RolesGuard) is verified at the module composition
 * level; here we just exercise that the controller threads ctx, ids, and
 * bodies to the service untouched.
 */
import { describe, expect, it } from 'vitest';
import { VendorStaffController } from './vendor-staff.controller.js';
import type {
  InviteStaffRequestDto,
  PatchStaffRequestDto,
  VendorStaffListResponse,
  VendorStaffResponse,
} from './dto/index.js';
import type { VendorContext } from '../../listings/vendor/vendor-context.types.js';
import type { VendorStaffService } from './vendor-staff.service.js';

const CTX: VendorContext = {
  dispensaryId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  staffRole: 'owner',
  staffMemberId: '01935f3d-0000-7000-8000-0000000000a2',
};

const STAFF_ID = '01935f3d-0000-7000-8000-0000000000a3';

const MEMBER: VendorStaffResponse = {
  id: STAFF_ID,
  userId: '01935f3d-0000-7000-8000-0000000000a5',
  role: 'budtender',
  email: 'bud@example.com',
  firstName: 'Bud',
  lastName: 'Tender',
  mfaEnabled: true,
  lastLoginAt: '2026-05-19T12:00:00.000Z',
  invitedAt: '2026-05-01T00:00:00.000Z',
  acceptedAt: '2026-05-01T01:00:00.000Z',
  removedAt: null,
};

const LIST_RESPONSE: VendorStaffListResponse = { staff: [MEMBER] };

class FakeVendorStaffService {
  public listCalls: VendorContext[] = [];
  public inviteCalls: { ctx: VendorContext; body: InviteStaffRequestDto }[] = [];
  public patchCalls: {
    ctx: VendorContext;
    id: string;
    body: PatchStaffRequestDto;
  }[] = [];
  public removeCalls: { ctx: VendorContext; id: string }[] = [];

  list = (ctx: VendorContext): Promise<VendorStaffListResponse> => {
    this.listCalls.push(ctx);
    return Promise.resolve(LIST_RESPONSE);
  };

  invite = (ctx: VendorContext, body: InviteStaffRequestDto): Promise<VendorStaffResponse> => {
    this.inviteCalls.push({ ctx, body });
    return Promise.resolve(MEMBER);
  };

  patchRole = (
    ctx: VendorContext,
    id: string,
    body: PatchStaffRequestDto,
  ): Promise<VendorStaffResponse> => {
    this.patchCalls.push({ ctx, id, body });
    return Promise.resolve(MEMBER);
  };

  remove = (ctx: VendorContext, id: string): Promise<void> => {
    this.removeCalls.push({ ctx, id });
    return Promise.resolve();
  };
}

describe('VendorStaffController', () => {
  it('list — forwards ctx and returns the list response', async () => {
    const svc = new FakeVendorStaffService();
    const controller = new VendorStaffController(svc as unknown as VendorStaffService);

    const result = await controller.list(CTX);

    expect(svc.listCalls).toEqual([CTX]);
    expect(result).toEqual(LIST_RESPONSE);
  });

  it('invite — forwards (ctx, body) and returns the created member', async () => {
    const svc = new FakeVendorStaffService();
    const controller = new VendorStaffController(svc as unknown as VendorStaffService);

    const body: InviteStaffRequestDto = {
      email: 'invitee@example.com',
      role: 'manager',
    } as InviteStaffRequestDto;
    const result = await controller.invite(CTX, body);

    expect(svc.inviteCalls).toEqual([{ ctx: CTX, body }]);
    expect(result).toEqual(MEMBER);
  });

  it('patchRole — forwards (ctx, id, body) and returns the patched member', async () => {
    const svc = new FakeVendorStaffService();
    const controller = new VendorStaffController(svc as unknown as VendorStaffService);

    const body: PatchStaffRequestDto = { role: 'manager' } as PatchStaffRequestDto;
    const result = await controller.patchRole(CTX, STAFF_ID, body);

    expect(svc.patchCalls).toEqual([{ ctx: CTX, id: STAFF_ID, body }]);
    expect(result).toEqual(MEMBER);
  });

  it('remove — forwards (ctx, id) and returns void', async () => {
    const svc = new FakeVendorStaffService();
    const controller = new VendorStaffController(svc as unknown as VendorStaffService);

    await controller.remove(CTX, STAFF_ID);

    expect(svc.removeCalls).toEqual([{ ctx: CTX, id: STAFF_ID }]);
  });
});
