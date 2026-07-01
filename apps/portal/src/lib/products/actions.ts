'use server';

/**
 * Next.js server actions for the vendor product-authoring surface. Each action
 * builds a request-scoped ApiClient from the Auth.js session and proxies to the
 * typed call in lib/api/vendor-products.ts — the access token never leaves the
 * server runtime. Same `buildServerApiClient` no-dispensary-context guard as
 * the listings/settings actions.
 */
import { buildServerApiClient } from '../api/server-client.js';
import {
  createVendorProduct,
  deleteVendorProduct,
  listVendorProducts,
  patchVendorProduct,
  requestProductImageUpload,
  type CreateVendorProductInput,
  type PatchVendorProductInput,
  type VendorProduct,
} from '../api/vendor-products.js';
import { NoDispensaryContextError } from '../listings/actions-errors.js';
import type { ApiClient } from '../api/client.js';
import type { ImageUploadTicket, UploadableImageType } from '../api/image-uploads.js';

async function authedClient(): Promise<ApiClient> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    throw new NoDispensaryContextError();
  }
  return ctx.client;
}

export async function listVendorProductsAction(): Promise<readonly VendorProduct[]> {
  const result = await listVendorProducts(await authedClient());
  return result.products;
}

export async function createVendorProductAction(
  input: CreateVendorProductInput,
): Promise<VendorProduct> {
  return createVendorProduct(await authedClient(), input);
}

export async function patchVendorProductAction(
  id: string,
  input: PatchVendorProductInput,
): Promise<VendorProduct> {
  return patchVendorProduct(await authedClient(), id, input);
}

export async function deleteVendorProductAction(id: string): Promise<void> {
  return deleteVendorProduct(await authedClient(), id);
}

export async function requestProductImageUploadAction(
  contentType: UploadableImageType,
): Promise<ImageUploadTicket> {
  return requestProductImageUpload(await authedClient(), contentType);
}
