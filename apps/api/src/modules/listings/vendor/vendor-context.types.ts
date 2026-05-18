/**
 * Shape of the dispensary-scoped vendor context the VendorContextGuard
 * attaches to the request. Kept in its own file so the decorator, guard,
 * controller, and downstream services can import it without creating a
 * decorator ↔ guard cycle (same layering as auth-types.ts).
 *
 * `staffRole` is the *per-dispensary* role from `dispensary_staff` — distinct
 * from the global `AuthenticatedUser.role` claim on the JWT. A user can hold
 * `owner` at one dispensary and `budtender` at another; the guard returns
 * the role for the dispensary that matches the X-Dispensary-Id header.
 */
import type { StaffRole } from '@dankdash/db';

export interface VendorContext {
  readonly dispensaryId: string;
  readonly userId: string;
  readonly staffRole: StaffRole;
  readonly staffMemberId: string;
}

export const VENDOR_CONTEXT_REQUEST_KEY = 'dankdash:vendorContext';
