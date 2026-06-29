'use server';

/**
 * Next.js server actions for the vendor-settings surface. Each action
 * builds a request-scoped `ApiClient` from the Auth.js session and
 * proxies to the typed call in `lib/api/vendor-settings.ts`. The
 * settings page calls these from the browser via the
 * `VendorSettingsActions` interface — the access token never leaves
 * the server runtime.
 *
 * Same rationale as `lib/staff/actions.ts`: server actions get full
 * Auth.js refresh semantics for free, and `buildServerApiClient`
 * enforces the "no-dispensary-context → typed error" guard so a stray
 * click during an unsupported state surfaces as a typed error, not a
 * 500.
 *
 * NOTE: Next.js 15 server-action files restrict top-level exports to
 * async functions. Helpers and error types live in
 * `actions-errors.ts`.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  getVendorSettings,
  patchVendorSettings,
  requestBrandImageUpload,
  type PatchVendorSettingsInput,
  type VendorSettings,
} from '../api/vendor-settings.js';
import { NoDispensaryContextError } from './actions-errors.js';
import type { ApiClient } from '../api/client.js';
import type { ImageUploadTicket, UploadableImageType } from '../api/image-uploads.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function getVendorSettingsAction(): Promise<VendorSettings> {
  return getVendorSettings(await authedClient());
}

export async function patchVendorSettingsAction(
  input: PatchVendorSettingsInput,
): Promise<VendorSettings> {
  return patchVendorSettings(await authedClient(), input);
}

export async function requestBrandImageUploadAction(
  contentType: UploadableImageType,
): Promise<ImageUploadTicket> {
  return requestBrandImageUpload(await authedClient(), contentType);
}
