/**
 * Contract the settings page uses to talk to the vendor-settings
 * surface. Factored as an interface so production wires the Next
 * server actions while tests inject in-memory fakes (no Auth.js, no
 * Next runtime). Mirrors `VendorStaffActions` from Phase 15.4.
 */
import type { PatchVendorSettingsInput, VendorSettings } from '../api/vendor-settings.js';

export interface VendorSettingsActions {
  /** Re-fetches the settings snapshot. Called after every mutation. */
  readonly get: () => Promise<VendorSettings>;
  /** Patches one or more editable fields. Returns the full updated row. */
  readonly patch: (input: PatchVendorSettingsInput) => Promise<VendorSettings>;
}
