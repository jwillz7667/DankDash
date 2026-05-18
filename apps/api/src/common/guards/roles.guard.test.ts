/**
 * Unit tests for RolesGuard.
 *
 * The guard's surface is small: no @Roles metadata → allow; user missing
 * (which means the route was @Public + @Roles, a controller mistake) →
 * 403; role outside the allow-list → 403 with details; role present →
 * allow. We exercise each branch directly against a hand-rolled
 * ExecutionContext rather than spinning Nest, matching the rate-limit
 * guard's test style.
 */
import { ForbiddenError } from '@dankdash/types';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../../modules/auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../modules/auth/guards/roles.guard.js';
import type { UserRoleDto } from '../../modules/auth/dto/user-summary.dto.js';
import type { AuthenticatedUser } from '../../modules/auth/guards/auth-types.js';
import type { ExecutionContext } from '@nestjs/common';

class FakeRolesController {
  readonly kind = 'fake-roles' as const;
}

function makeContext(
  user: AuthenticatedUser | undefined,
  roles: readonly UserRoleDto[] | undefined,
): ExecutionContext {
  const handler = (): void => undefined;
  if (roles !== undefined) {
    Reflect.defineMetadata(ROLES_KEY, roles, handler);
  }
  return {
    getHandler: (): unknown => handler,
    getClass: (): unknown => FakeRolesController,
    switchToHttp: (): unknown => ({
      getRequest: (): { user?: AuthenticatedUser } => (user === undefined ? {} : { user }),
      getResponse: (): unknown => ({}),
      getNext: (): unknown => ({}),
    }),
    switchToRpc: (): unknown => ({}),
    switchToWs: (): unknown => ({}),
    getArgs: (): readonly unknown[] => [],
    getArgByIndex: (): unknown => undefined,
    getType: (): string => 'http',
  } as unknown as ExecutionContext;
}

const ADMIN: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'admin',
};

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows the call when no @Roles metadata is present', () => {
    expect(guard.canActivate(makeContext(ADMIN, undefined))).toBe(true);
  });

  it('allows the call when @Roles is present but empty (treated as no constraint)', () => {
    expect(guard.canActivate(makeContext(ADMIN, []))).toBe(true);
  });

  it('allows the call when the user role matches the allow-list', () => {
    expect(guard.canActivate(makeContext(ADMIN, ['admin', 'superadmin']))).toBe(true);
  });

  it('throws ForbiddenError when the user role is outside the allow-list', () => {
    const customer: AuthenticatedUser = { ...ADMIN, role: 'customer' };
    expect(() => guard.canActivate(makeContext(customer, ['admin']))).toThrowError(ForbiddenError);
  });

  it('attaches required + actual role to the ForbiddenError details', () => {
    const driver: AuthenticatedUser = { ...ADMIN, role: 'driver' };
    try {
      guard.canActivate(makeContext(driver, ['manager', 'owner']));
      expect.fail('expected ForbiddenError');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).details).toMatchObject({
        required: ['manager', 'owner'],
        actual: 'driver',
      });
    }
  });

  it('throws ForbiddenError when @Roles is set but the route has no principal', () => {
    // The "@Public + @Roles" combination is a controller bug; the guard
    // surfaces it loudly rather than silently allowing the call through.
    expect(() => guard.canActivate(makeContext(undefined, ['admin']))).toThrowError(ForbiddenError);
  });
});
