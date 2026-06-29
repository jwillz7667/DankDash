/**
 * Typed surface for the vendor-settings endpoints the portal consumes.
 *
 * Mirrors the wire shape from `apps/api/src/modules/settings/vendor/dto/`:
 *
 *   - `VendorSettingsResponseSchema` → {@link VendorSettings}
 *   - `PatchVendorSettingsSchema`    → body of {@link patchVendorSettings}
 *
 * Hand-mirrored rather than imported to keep NestJS metadata out of the
 * Next bundle (same rationale as the other `vendor-*.ts` clients).
 *
 * Sensitive blobs (encrypted Metrc API key, encrypted POS credentials,
 * Aeropay account ref) are NOT mirrored here — the API replaces them
 * with `hasMetrcCredentials` / `hasPosCredentials` / `hasAeropayAccount`
 * booleans so the portal can render "configured ✓" without ever
 * receiving the secret.
 */
import type { ApiClient } from './client.js';
import type { ImageUploadTicket, UploadableImageType } from './image-uploads.js';

export type LicenseType =
  | 'retailer'
  | 'microbusiness'
  | 'mezzobusiness'
  | 'medical_combo'
  | 'delivery_service'
  | 'lphe_retailer';

export type DispensaryStatus = 'onboarding' | 'active' | 'paused' | 'terminated';

export type PosProvider = 'dutchie' | 'flowhub' | 'treez' | 'greenbits' | 'cova' | 'manual';

export interface GeoPoint {
  readonly type: 'Point';
  readonly coordinates: readonly [number, number];
}

export interface GeoPolygon {
  readonly type: 'Polygon';
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

export interface DayHours {
  readonly open: string;
  readonly close: string;
}

export interface DispensaryHours {
  readonly mon: DayHours | null;
  readonly tue: DayHours | null;
  readonly wed: DayHours | null;
  readonly thu: DayHours | null;
  readonly fri: DayHours | null;
  readonly sat: DayHours | null;
  readonly sun: DayHours | null;
}

export interface VendorSettings {
  readonly id: string;
  readonly legalName: string;
  readonly dba: string | null;

  readonly licenseNumber: string;
  readonly licenseType: LicenseType;
  /** ISO calendar date (YYYY-MM-DD). */
  readonly licenseIssuedAt: string;
  /** ISO calendar date (YYYY-MM-DD). */
  readonly licenseExpiresAt: string;

  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly location: GeoPoint;
  readonly deliveryPolygon: GeoPolygon;

  readonly hours: DispensaryHours;

  readonly phone: string | null;
  readonly email: string | null;

  readonly logoImageKey: string | null;
  readonly heroImageKey: string | null;
  readonly brandColorHex: string | null;

  readonly isAcceptingOrders: boolean;
  readonly status: DispensaryStatus;

  readonly posProvider: PosProvider;
  readonly posLastSyncedAt: string | null;
  readonly hasPosCredentials: boolean;

  readonly metrcFacilityId: string | null;
  readonly hasMetrcCredentials: boolean;

  readonly hasAeropayAccount: boolean;

  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PatchVendorSettingsInput {
  readonly hours?: DispensaryHours;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly logoImageKey?: string | null;
  readonly heroImageKey?: string | null;
  readonly brandColorHex?: string | null;
  readonly isAcceptingOrders?: boolean;
}

export async function getVendorSettings(client: ApiClient): Promise<VendorSettings> {
  return client.request<VendorSettings>('/v1/vendor/settings');
}

export async function patchVendorSettings(
  client: ApiClient,
  body: PatchVendorSettingsInput,
): Promise<VendorSettings> {
  return client.request<VendorSettings>('/v1/vendor/settings', {
    method: 'PATCH',
    body,
  });
}

/**
 * POST /v1/vendor/settings/image-uploads — mint a presigned R2 upload for a
 * single brand asset (storefront hero or logo). The dispensary scope comes
 * from the client's `X-Dispensary-Id` header, so the minted key is always
 * under the caller's own `brand/` prefix. The returned `objectKey` is then
 * persisted via {@link patchVendorSettings} ({ heroImageKey } / { logoImageKey }).
 *
 * The browser uploads the bytes straight to R2 with
 * {@link import('./image-uploads.js').uploadImageToStorage}; large image
 * payloads never traverse the portal's Node runtime.
 */
export async function requestBrandImageUpload(
  client: ApiClient,
  contentType: UploadableImageType,
): Promise<ImageUploadTicket> {
  return client.request<ImageUploadTicket>('/v1/vendor/settings/image-uploads', {
    method: 'POST',
    body: { contentType },
  });
}
