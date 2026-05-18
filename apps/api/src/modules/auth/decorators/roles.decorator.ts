/**
 * Attach a required-role allow-list to a controller method (or class). The
 * RolesGuard reads this metadata via Reflector and rejects requests whose
 * `req.user.role` is not in the set.
 *
 * Roles are checked *additively* against the user's primary role from the
 * access-token claim (`role`). A future per-dispensary RBAC layer (Phase
 * 5) will add a separate `@DispensaryRoles(...)` decorator that consults
 * `dispensary_staff` rather than the global role.
 */
import { SetMetadata } from '@nestjs/common';
import type { UserRoleDto } from '../dto/user-summary.dto.js';

export const ROLES_KEY = 'auth:roles';

export const Roles = (...roles: readonly UserRoleDto[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
