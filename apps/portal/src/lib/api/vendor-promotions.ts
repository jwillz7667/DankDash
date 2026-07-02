/**
 * Typed surface for the vendor promotions endpoints
 * (`/v1/vendor/promotions`). Mirrors the API PromoResponse + the
 * Create/Patch promo DTOs, hand-mirrored to keep NestJS metadata out of the
 * Next bundle (same rationale as the other vendor-*.ts clients).
 *
 * Money rides as integer CENTS end-to-end (`minSubtotalCents`,
 * `maxDiscountCents`); `value` is polymorphic by `type` — whole percent for
 * `percent`, integer cents for `fixed_amount`, and `0` for `free_delivery`.
 * The editor converts vendor-entered dollars to cents before building the
 * payload and never does float math on the wire values.
 */
import type { ApiClient } from './client.js';

export type PromoType = 'percent' | 'fixed_amount' | 'free_delivery';
export type PromoScope = 'platform' | 'dispensary';

export interface VendorPromotion {
  readonly id: string;
  readonly code: string;
  readonly type: PromoType;
  /** Whole percent (1..100) for `percent`, integer cents for `fixed_amount`, `0` for `free_delivery`. */
  readonly value: number;
  readonly scope: PromoScope;
  readonly dispensaryId: string | null;
  readonly minSubtotalCents: number;
  /** Cap on the computed discount for `percent` promos, in cents. Null = uncapped. */
  readonly maxDiscountCents: number | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  /** Global redemption cap. Null = unlimited. */
  readonly maxRedemptions: number | null;
  readonly maxRedemptionsPerUser: number;
  readonly active: boolean;
  readonly redemptionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Create body — mirrors CreatePromoRequest. Dispensary ownership is header-derived. */
export interface CreateVendorPromotionInput {
  readonly code: string;
  readonly type: PromoType;
  readonly value: number;
  readonly minSubtotalCents?: number;
  readonly maxDiscountCents?: number | null;
  readonly startsAt: string;
  readonly endsAt?: string | null;
  readonly maxRedemptions?: number | null;
  readonly maxRedemptionsPerUser?: number;
}

/** Patch body — mirrors PatchPromoRequest. Only the active flag is mutable post-create. */
export interface PatchVendorPromotionInput {
  readonly active?: boolean;
}

export async function listVendorPromotions(
  client: ApiClient,
): Promise<{ promotions: readonly VendorPromotion[] }> {
  return client.request<{ promotions: readonly VendorPromotion[] }>('/v1/vendor/promotions');
}

export async function createVendorPromotion(
  client: ApiClient,
  body: CreateVendorPromotionInput,
): Promise<VendorPromotion> {
  return client.request<VendorPromotion>('/v1/vendor/promotions', { method: 'POST', body });
}

export async function patchVendorPromotion(
  client: ApiClient,
  promotionId: string,
  body: PatchVendorPromotionInput,
): Promise<VendorPromotion> {
  return client.request<VendorPromotion>(
    `/v1/vendor/promotions/${encodeURIComponent(promotionId)}`,
    { method: 'PATCH', body },
  );
}

export async function deleteVendorPromotion(client: ApiClient, promotionId: string): Promise<void> {
  await client.request<unknown>(`/v1/vendor/promotions/${encodeURIComponent(promotionId)}`, {
    method: 'DELETE',
  });
}
