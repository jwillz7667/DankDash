'use server';

/**
 * Next.js server action for the payout bank-link surface. Builds a
 * request-scoped `ApiClient` from the Auth.js session and proxies to the
 * typed call in `lib/api/vendor-payouts.ts`. The payouts page passes this
 * to the bank-account panel via the `PayoutBankActions` interface — the
 * access token never leaves the server runtime; only the one-time hosted
 * Aeropay URL crosses back to the browser.
 *
 * Same rationale as `lib/settings/actions.ts`: server actions get full
 * Auth.js refresh semantics for free, and `buildServerApiClient` enforces
 * the "no-dispensary-context → typed error" guard so a stray click during
 * an unsupported state surfaces as a typed error, not a 500.
 *
 * NOTE: Next.js 15 server-action files restrict top-level exports to async
 * functions. Error types live in `actions-errors.ts`.
 */
import { buildServerApiClient } from '../api/server-client.js';
import { startVendorBankLink, type StartDispensaryBankLinkResult } from '../api/vendor-payouts.js';
import { NoDispensaryContextError } from './actions-errors.js';
import type { ApiClient } from '../api/client.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function startBankLinkAction(
  returnUrl: string,
): Promise<StartDispensaryBankLinkResult> {
  return startVendorBankLink(await authedClient(), returnUrl);
}
