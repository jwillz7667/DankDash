/**
 * Shape of the principal attached by JwtAuthGuard to the request. Kept in
 * its own file so decorators, guards, and controllers can import it
 * without creating a guard ↔ decorator cycle.
 */
import type { UserRoleDto } from '../dto/user-summary.dto.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: UserRoleDto;
}
