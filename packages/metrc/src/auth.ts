/**
 * Metrc Basic-auth header helper.
 *
 * Metrc's API uses HTTP Basic auth with two tightly-coupled keys:
 *
 *   - **Vendor key**: identifies the integration partner (us). One key per
 *     state we operate in. Loaded once at worker boot from the
 *     `METRC_VENDOR_API_KEY` env and passed into the client at
 *     construction.
 *   - **User key**: identifies the dispensary / facility. One per
 *     dispensary. Encrypted at rest on `dispensaries.metrc_api_key_enc`
 *     (envelope encryption, AAD context
 *     `dispensaries.metrc_api_key_enc`) and decrypted in the worker just
 *     in time for the request.
 *
 * The wire format is `Basic base64(<vendorKey>:<userKey>)`. Unlike
 * Aeropay's OAuth bearer flow, there is no TTL and no token caching —
 * Metrc accepts every request as long as the credentials are valid. That
 * also means we never have a forgivable "credential rotated mid-flight"
 * recovery path; a 401 from Metrc is a hard configuration failure that
 * paging ops to investigate is the correct response to.
 *
 * The helper is exposed as a pure function so it's free to call per
 * request — there's no shared state and no perf cost to redoing the
 * base64 encode (it's microseconds against a multi-second HTTP roundtrip).
 */
import { ExternalServiceError } from '@dankdash/types';

const SERVICE = 'metrc';

/**
 * Build the `Authorization` header value for a Metrc request.
 *
 * Both keys are validated as non-empty at boundary — passing an empty
 * string here is a programmer error (the worker should refuse to schedule
 * a transaction with missing credentials) but failing loudly here keeps
 * the failure attribution at the call site instead of upstream.
 */
export function buildBasicAuthHeader(vendorKey: string, userKey: string): string {
  if (vendorKey.length === 0) {
    throw new ExternalServiceError(SERVICE, 'Metrc vendor API key is empty', {
      field: 'vendorKey',
    });
  }
  if (userKey.length === 0) {
    throw new ExternalServiceError(SERVICE, 'Metrc user API key is empty', {
      field: 'userKey',
    });
  }
  const encoded = Buffer.from(`${vendorKey}:${userKey}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}
