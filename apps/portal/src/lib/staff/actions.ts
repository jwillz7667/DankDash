'use server';

/**
 * Next.js server actions for the vendor-staff surface. Each action
 * builds a request-scoped `ApiClient` from the Auth.js session and
 * proxies to the typed call in `lib/api/vendor-staff.ts`. The staff
 * page (and the invite form / role controls) call these from the
 * browser via the `VendorStaffActions` interface — the access token
 * never leaves the server runtime.
 *
 * Same rationale as `lib/listings/actions.ts`: server actions get full
 * Auth.js refresh semantics for free, and `buildServerApiClient` enforces
 * the "no-dispensary-context → typed error" guard so a stray click during
 * an unsupported state surfaces as a typed error, not a 500.
 *
 * NOTE: Next.js 15 server-action files restrict top-level exports to
 * async functions. Helpers and error types live in `actions-errors.ts`.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  inviteVendorStaff,
  listVendorStaff,
  patchVendorStaffRole,
  removeVendorStaff,
  type InviteStaffInput,
  type PatchStaffInput,
  type VendorStaffMember,
} from '../api/vendor-staff.js';
import { NoDispensaryContextError } from './actions-errors.js';
import type { ApiClient } from '../api/client.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function listVendorStaffAction(): Promise<readonly VendorStaffMember[]> {
  const result = await listVendorStaff(await authedClient());
  return result.staff;
}

export async function inviteVendorStaffAction(input: InviteStaffInput): Promise<VendorStaffMember> {
  return inviteVendorStaff(await authedClient(), input);
}

export async function patchVendorStaffRoleAction(
  staffId: string,
  input: PatchStaffInput,
): Promise<VendorStaffMember> {
  return patchVendorStaffRole(await authedClient(), staffId, input);
}

export async function removeVendorStaffAction(staffId: string): Promise<void> {
  return removeVendorStaff(await authedClient(), staffId);
}
