'use server';

/**
 * Next.js server actions for the vendor promotions surface. Each action
 * builds a request-scoped ApiClient from the Auth.js session and proxies to
 * the typed call in lib/api/vendor-promotions.ts — the access token never
 * leaves the server runtime. Same `buildServerApiClient` no-dispensary-context
 * guard as the products/listings/settings actions.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  createVendorPromotion,
  deleteVendorPromotion,
  listVendorPromotions,
  patchVendorPromotion,
  type CreateVendorPromotionInput,
  type PatchVendorPromotionInput,
  type VendorPromotion,
} from '../api/vendor-promotions.js';
import { NoDispensaryContextError } from '../listings/actions-errors.js';
import type { ApiClient } from '../api/client.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function listVendorPromotionsAction(): Promise<readonly VendorPromotion[]> {
  const result = await listVendorPromotions(await authedClient());
  return result.promotions;
}

export async function createVendorPromotionAction(
  input: CreateVendorPromotionInput,
): Promise<VendorPromotion> {
  return createVendorPromotion(await authedClient(), input);
}

export async function patchVendorPromotionAction(
  id: string,
  input: PatchVendorPromotionInput,
): Promise<VendorPromotion> {
  return patchVendorPromotion(await authedClient(), id, input);
}

export async function deactivateVendorPromotionAction(id: string): Promise<void> {
  return deleteVendorPromotion(await authedClient(), id);
}
