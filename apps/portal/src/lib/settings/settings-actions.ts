/**
 * Contract the settings page uses to talk to the vendor-settings
 * surface. Factored as an interface so production wires the Next
 * server actions while tests inject in-memory fakes (no Auth.js, no
 * Next runtime). Mirrors `VendorStaffActions` from Phase 15.4.
 */
import type { ImageUploadTicket, UploadableImageType } from '../api/image-uploads.js';
import type { PatchVendorSettingsInput, VendorSettings } from '../api/vendor-settings.js';

export interface VendorSettingsActions {
  /** Re-fetches the settings snapshot. Called after every mutation. */
  readonly get: () => Promise<VendorSettings>;
  /** Patches one or more editable fields. Returns the full updated row. */
  readonly patch: (input: PatchVendorSettingsInput) => Promise<VendorSettings>;
  /**
   * Mints a presigned R2 upload ticket for a brand asset (hero/logo). The
   * caller uploads the bytes directly to R2, then `patch`es the returned
   * object key onto `heroImageKey` / `logoImageKey`.
   */
  readonly requestImageUpload: (contentType: UploadableImageType) => Promise<ImageUploadTicket>;
}
