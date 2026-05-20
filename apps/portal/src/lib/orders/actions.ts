'use server';

/**
 * Next.js server actions for the vendor-orders surface. Each action
 * builds a request-scoped `ApiClient` from the Auth.js session and
 * proxies to the typed call in `lib/api/vendor-orders.ts`. The drawer
 * (and, in Phase 14.3, the drag-drop layer) calls these from the
 * browser via the `VendorOrderActions` interface — the access token
 * never leaves the server runtime.
 *
 * Why server actions and not a client-side `ApiClient`?
 *
 *   - The access token would have to live in the browser bundle for a
 *     client-side `ApiClient` to call the API directly. We already leak
 *     it for the Socket.io handshake, but each additional leak surface
 *     is one we'd rather not have.
 *   - Server actions get full Auth.js refresh semantics for free — if a
 *     token expired between page render and the user's click, the
 *     in-flight refresh logic in `ApiClient` rotates it transparently.
 *   - `buildServerApiClient` already enforces the
 *     "no-dispensary-context → no-op" guard, so a stray click during an
 *     unsupported state surfaces as a typed error, not a 500.
 *
 * NOTE: Next.js 15 server-action files restrict top-level exports to
 * async functions. Helpers and error types live in `actions-errors.ts`.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  acceptVendorOrder,
  getVendorOrder,
  markVendorOrderHandoff,
  markVendorOrderPrepped,
  markVendorOrderReady,
  rejectVendorOrder,
  type TransitionResponse,
  type VendorOrderDetail,
} from '../api/vendor-orders.js';
import { NoDispensaryContextError } from './actions-errors.js';
import type { ApiClient } from '../api/client.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function fetchVendorOrderAction(orderId: string): Promise<VendorOrderDetail> {
  return getVendorOrder(await authedClient(), orderId);
}

export async function acceptVendorOrderAction(orderId: string): Promise<TransitionResponse> {
  return acceptVendorOrder(await authedClient(), orderId);
}

export async function rejectVendorOrderAction(
  orderId: string,
  reason: string,
): Promise<TransitionResponse> {
  return rejectVendorOrder(await authedClient(), orderId, reason);
}

export async function markVendorOrderPreppedAction(orderId: string): Promise<TransitionResponse> {
  return markVendorOrderPrepped(await authedClient(), orderId);
}

export async function markVendorOrderReadyAction(orderId: string): Promise<TransitionResponse> {
  return markVendorOrderReady(await authedClient(), orderId);
}

export async function markVendorOrderHandoffAction(orderId: string): Promise<TransitionResponse> {
  return markVendorOrderHandoff(await authedClient(), orderId);
}
