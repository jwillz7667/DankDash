/**
 * Typed surface for the vendor-staff endpoints the portal consumes.
 *
 * Mirrors the wire shape from `apps/api/src/modules/staff/vendor/dto/`:
 *
 *   - `VendorStaffMemberSchema`        → {@link VendorStaffMember}
 *   - `VendorStaffListResponseSchema`  → return of {@link listVendorStaff}
 *   - `InviteStaffRequestSchema`       → body of {@link inviteVendorStaff}
 *   - `PatchStaffRequestSchema`        → body of {@link patchVendorStaffRole}
 *
 * Hand-mirrored rather than imported to keep NestJS metadata out of the
 * Next bundle (same rationale as `vendor-payouts.ts` and friends). A drift
 * between this and the API DTO surfaces as a typecheck failure on the
 * consumer that reads a field that no longer exists.
 */
import type { ApiClient } from './client.js';

export type VendorStaffRole = 'budtender' | 'manager' | 'owner';

export interface VendorStaffMember {
  readonly id: string;
  readonly userId: string;
  readonly role: VendorStaffRole;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly removedAt: string | null;
}

export interface VendorStaffListResult {
  readonly staff: readonly VendorStaffMember[];
}

export interface InviteStaffInput {
  readonly email: string;
  readonly role: VendorStaffRole;
}

export interface PatchStaffInput {
  readonly role: VendorStaffRole;
}

export async function listVendorStaff(client: ApiClient): Promise<VendorStaffListResult> {
  return client.request<VendorStaffListResult>('/v1/vendor/staff');
}

export async function inviteVendorStaff(
  client: ApiClient,
  body: InviteStaffInput,
): Promise<VendorStaffMember> {
  return client.request<VendorStaffMember>('/v1/vendor/staff', {
    method: 'POST',
    body,
  });
}

export async function patchVendorStaffRole(
  client: ApiClient,
  staffId: string,
  body: PatchStaffInput,
): Promise<VendorStaffMember> {
  return client.request<VendorStaffMember>(`/v1/vendor/staff/${encodeURIComponent(staffId)}`, {
    method: 'PATCH',
    body,
  });
}

export async function removeVendorStaff(client: ApiClient, staffId: string): Promise<void> {
  await client.request<unknown>(`/v1/vendor/staff/${encodeURIComponent(staffId)}`, {
    method: 'DELETE',
  });
}
