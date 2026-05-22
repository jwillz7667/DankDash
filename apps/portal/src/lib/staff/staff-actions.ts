/**
 * Contract the staff page uses to talk to the vendor-staff surface.
 * Factored out as an interface so:
 *
 *   - Production wires the Next.js server actions in {@link import('./actions.js')}
 *     (which call `ApiClient` server-side, never leaking the access token).
 *   - Tests inject in-memory fakes — no Auth.js session, no Next runtime.
 *
 * Mirrors the `VendorListingActions` pattern from Phase 15.1.
 */
import type { InviteStaffInput, PatchStaffInput, VendorStaffMember } from '../api/vendor-staff.js';

export interface VendorStaffActions {
  /** Replace the table snapshot. Called after every mutation. */
  readonly list: () => Promise<readonly VendorStaffMember[]>;
  /** Invite a new staff member by email. Returns the new (or resurrected) row. */
  readonly invite: (input: InviteStaffInput) => Promise<VendorStaffMember>;
  /** Change a staff member's role. Returns the patched row. */
  readonly patchRole: (staffId: string, input: PatchStaffInput) => Promise<VendorStaffMember>;
  /** Soft-remove (revokes access). Idempotent on already-removed rows. */
  readonly remove: (staffId: string) => Promise<void>;
}
