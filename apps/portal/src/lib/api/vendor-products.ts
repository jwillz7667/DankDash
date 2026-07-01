/**
 * Typed surface for the vendor product-authoring endpoints
 * (`/v1/vendor/products`). Mirrors the API ProductResponse + the
 * Create/Patch product DTOs, hand-mirrored to keep NestJS metadata out of the
 * Next bundle (same rationale as the other vendor-*.ts clients).
 *
 * Numeric potency/weight ride as DECIMAL STRINGS end-to-end (the API stores
 * NUMERIC(10,3)); the editor parses/formats them but never does float math.
 */
import type { ApiClient } from './client.js';
import type { ImageUploadTicket, UploadableImageType } from './image-uploads.js';

export type ProductType =
  | 'flower'
  | 'preroll'
  | 'infused_preroll'
  | 'vape'
  | 'edible'
  | 'beverage'
  | 'concentrate'
  | 'tincture'
  | 'topical'
  | 'accessory'
  | 'seed'
  | 'clone';

export type StrainType = 'indica' | 'sativa' | 'hybrid' | 'cbd' | 'balanced';

export interface VendorProduct {
  readonly id: string;
  readonly categoryId: string;
  readonly brand: string;
  readonly name: string;
  readonly description: string | null;
  readonly productType: ProductType;
  readonly strainType: StrainType | null;
  readonly thcMgPerUnit: string;
  readonly cbdMgPerUnit: string;
  readonly weightGramsPerUnit: string;
  readonly servingCount: number | null;
  readonly thcMgPerServing: string | null;
  readonly imageKeys: readonly string[];
  readonly effectsTags: readonly string[];
  readonly flavorTags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Create body — mirrors CreateProductRequest. dispensary ownership is header-derived. */
export interface CreateVendorProductInput {
  readonly categoryId: string;
  readonly brand: string;
  readonly name: string;
  readonly description?: string | null;
  readonly productType: ProductType;
  readonly strainType?: StrainType | null;
  readonly thcMgPerUnit: string;
  readonly cbdMgPerUnit?: string;
  readonly weightGramsPerUnit?: string;
  readonly servingCount?: number | null;
  readonly thcMgPerServing?: string | null;
  readonly imageKeys?: readonly string[];
  readonly effectsTags?: readonly string[];
  readonly flavorTags?: readonly string[];
}

/** Patch body — every field optional plus isActive; mirrors PatchProductRequest. */
export type PatchVendorProductInput = Partial<CreateVendorProductInput> & {
  readonly isActive?: boolean;
};

/** A product category the editor offers in its category picker. */
export interface ProductCategory {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly parentId: string | null;
  readonly displayOrder: number;
}

/** GET /v1/categories — public, flat, ordered by display order. */
export async function listProductCategories(
  client: ApiClient,
): Promise<readonly ProductCategory[]> {
  const res = await client.request<{ categories: readonly ProductCategory[] }>('/v1/categories');
  return res.categories;
}

export async function listVendorProducts(
  client: ApiClient,
): Promise<{ products: readonly VendorProduct[] }> {
  return client.request<{ products: readonly VendorProduct[] }>('/v1/vendor/products');
}

export async function createVendorProduct(
  client: ApiClient,
  body: CreateVendorProductInput,
): Promise<VendorProduct> {
  return client.request<VendorProduct>('/v1/vendor/products', { method: 'POST', body });
}

export async function patchVendorProduct(
  client: ApiClient,
  productId: string,
  body: PatchVendorProductInput,
): Promise<VendorProduct> {
  return client.request<VendorProduct>(`/v1/vendor/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body,
  });
}

export async function deleteVendorProduct(client: ApiClient, productId: string): Promise<void> {
  await client.request<unknown>(`/v1/vendor/products/${encodeURIComponent(productId)}`, {
    method: 'DELETE',
  });
}

/** POST /v1/vendor/products/image-uploads — presign a product photo upload. */
export async function requestProductImageUpload(
  client: ApiClient,
  contentType: UploadableImageType,
): Promise<ImageUploadTicket> {
  return client.request<ImageUploadTicket>('/v1/vendor/products/image-uploads', {
    method: 'POST',
    body: { contentType },
  });
}
