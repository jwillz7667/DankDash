/**
 * Unit tests for VendorContextGuard.
 *
 *   1. No req.user (route misconfigured @Public) — AuthError UNAUTHENTICATED.
 *   2. Missing X-Dispensary-Id header — ValidationError (422), distinct
 *      from 401/403 because the request itself is malformed.
 *   3. Non-UUID header value — ValidationError.
 *   4. Header references a dispensary the user does not staff —
 *      ForbiddenError. 403 not 404 so we do not leak whether the
 *      dispensary itself exists.
 *   5. Header references a dispensary the user *did* staff but has been
 *      removed from (`removedAt IS NOT NULL`) — ForbiddenError.
 *   6. Happy path — attaches { dispensaryId, userId, staffRole,
 *      staffMemberId } to req[VENDOR_CONTEXT_REQUEST_KEY].
 *   7. Header lookup is case-insensitive (Fastify normalizes to
 *      lowercase, but the regex is /iu so an uppercase UUID passes).
 *   8. Invited-but-unaccepted staff (`acceptedAt IS NULL`,
 *      `removedAt IS NULL`) are allowed — acceptedAt is an invitation
 *      UX state, not authorization.
 */
import { AuthError, ForbiddenError, ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { VendorContextGuard } from './vendor-context.guard.js';
import { VENDOR_CONTEXT_REQUEST_KEY, type VendorContext } from './vendor-context.types.js';
import type { AuthenticatedUser } from '../../auth/guards/auth-types.js';
import type { DispensaryStaffMember, DispensaryStaffRepository } from '@dankdash/db';
import type { ExecutionContext } from '@nestjs/common';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const STAFF_ID = '01935f3d-0000-7000-8000-000000000050';

interface FakeRequest {
  readonly headers: Record<string, string | undefined>;
  user?: AuthenticatedUser;
  [VENDOR_CONTEXT_REQUEST_KEY]?: VendorContext;
}

function makeContext(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: (): unknown => ({
      getRequest: (): FakeRequest => req,
      getResponse: (): unknown => ({}),
      getNext: (): unknown => ({}),
    }),
    switchToRpc: (): unknown => ({}),
    switchToWs: (): unknown => ({}),
    getHandler: (): unknown => undefined,
    getClass: (): unknown => undefined,
    getArgs: (): readonly unknown[] => [],
    getArgByIndex: (): unknown => undefined,
    getType: (): string => 'http',
  } as unknown as ExecutionContext;
}

function makeAuthenticatedUser(): AuthenticatedUser {
  return {
    userId: USER_ID,
    sessionId: '01935f3d-0000-7000-8000-000000000099',
    role: 'manager',
  };
}

function makeMembership(overrides: Partial<DispensaryStaffMember> = {}): DispensaryStaffMember {
  return {
    id: STAFF_ID,
    dispensaryId: DISPENSARY_ID,
    userId: USER_ID,
    role: 'manager',
    permissions: {},
    invitedAt: new Date('2026-01-01T00:00:00.000Z'),
    invitedBy: null,
    acceptedAt: new Date('2026-01-02T00:00:00.000Z'),
    removedAt: null,
    ...overrides,
  };
}

class FakeStaffRepo {
  public next: DispensaryStaffMember | null = null;
  public calls: { dispensaryId: string; userId: string }[] = [];

  findByDispensaryAndUser = (
    dispensaryId: string,
    userId: string,
  ): Promise<DispensaryStaffMember | null> => {
    this.calls.push({ dispensaryId, userId });
    return Promise.resolve(this.next);
  };
}

function buildGuard(): { guard: VendorContextGuard; staff: FakeStaffRepo } {
  const staff = new FakeStaffRepo();
  const guard = new VendorContextGuard(staff as unknown as DispensaryStaffRepository);
  return { guard, staff };
}

describe('VendorContextGuard', () => {
  it('throws UNAUTHENTICATED when req.user is missing (route misconfigured @Public)', async () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: { 'x-dispensary-id': DISPENSARY_ID } };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(AuthError);
  });

  it('throws ValidationError when the X-Dispensary-Id header is missing', async () => {
    const { guard } = buildGuard();
    const req: FakeRequest = { headers: {}, user: makeAuthenticatedUser() };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the X-Dispensary-Id header is not a UUID', async () => {
    const { guard } = buildGuard();
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': 'not-a-uuid' },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ForbiddenError when the user is not a staff member of the dispensary', async () => {
    const { guard, staff } = buildGuard();
    staff.next = null;
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': DISPENSARY_ID },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ForbiddenError);
    expect(staff.calls).toEqual([{ dispensaryId: DISPENSARY_ID, userId: USER_ID }]);
  });

  it('throws ForbiddenError when the staff membership has been revoked (removedAt set)', async () => {
    const { guard, staff } = buildGuard();
    staff.next = makeMembership({ removedAt: new Date('2026-04-01T00:00:00.000Z') });
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': DISPENSARY_ID },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('attaches VendorContext on the happy path', async () => {
    const { guard, staff } = buildGuard();
    staff.next = makeMembership({ role: 'owner' });
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': DISPENSARY_ID },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req[VENDOR_CONTEXT_REQUEST_KEY]).toEqual({
      dispensaryId: DISPENSARY_ID,
      userId: USER_ID,
      staffRole: 'owner',
      staffMemberId: STAFF_ID,
    });
  });

  it('accepts an uppercase UUID in the header (regex is /iu)', async () => {
    const { guard, staff } = buildGuard();
    staff.next = makeMembership();
    const upper = DISPENSARY_ID.toUpperCase();
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': upper },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(staff.calls[0]?.dispensaryId).toBe(upper);
  });

  it('admits invited-but-unaccepted staff (acceptedAt null) — invitation UX, not auth', async () => {
    const { guard, staff } = buildGuard();
    staff.next = makeMembership({ acceptedAt: null });
    const req: FakeRequest = {
      headers: { 'x-dispensary-id': DISPENSARY_ID },
      user: makeAuthenticatedUser(),
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });
});

describe('VENDOR_CONTEXT_REQUEST_KEY', () => {
  it('is namespaced so it cannot collide with first-party Fastify keys', () => {
    expect(VENDOR_CONTEXT_REQUEST_KEY.startsWith('dankdash:')).toBe(true);
  });
});
