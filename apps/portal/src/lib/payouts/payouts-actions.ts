/**
 * Contract the payouts bank-account panel uses to start an Aeropay bank
 * link. Factored as an interface so production wires the Next server
 * action while tests inject an in-memory fake (no Auth.js, no Next
 * runtime). Mirrors `VendorSettingsActions` from the settings surface.
 */
import type { StartDispensaryBankLinkResult } from '../api/vendor-payouts.js';

export interface PayoutBankActions {
  /**
   * Start an Aeropay hosted bank-link session for the active dispensary.
   * `returnUrl` is where Aeropay redirects the operator once linking
   * completes; the caller then navigates the browser to
   * `result.link.hostedUrl`.
   */
  readonly startLink: (returnUrl: string) => Promise<StartDispensaryBankLinkResult>;
}
