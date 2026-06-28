/**
 * Server-only environment access for checkout-web.
 *
 * Every API call this app makes runs server-side (RSC + Server Actions), so
 * the API base URL is a server secret, never a `NEXT_PUBLIC_*` value — the
 * browser never talks to the DankDash API directly. In production this points
 * at the internal API origin (Railway private network or api.dankdash.com);
 * locally it defaults to the dev API port.
 */
import { CheckoutError } from './errors.js';

const DEV_API_BASE_URL = 'http://localhost:3000';

/** Base URL of the DankDash API, no trailing slash. */
export function apiBaseUrl(): string {
  const raw = process.env['CHECKOUT_API_BASE_URL'] ?? process.env['INTERNAL_API_BASE_URL'];
  if (raw === undefined || raw.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new CheckoutError('CONFIG', 'CHECKOUT_API_BASE_URL is required in production');
    }
    return DEV_API_BASE_URL;
  }
  return raw.replace(/\/+$/, '');
}

/** Whether the session cookie should carry the Secure attribute. */
export function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}
