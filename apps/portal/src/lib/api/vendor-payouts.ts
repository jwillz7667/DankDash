/**
 * Typed surface for the vendor-payouts endpoints the portal consumes.
 *
 * Mirrors the wire shape from
 * `apps/api/src/modules/payouts/vendor/dto/`:
 *
 *   - `VendorPayoutSummarySchema`         → {@link VendorPayoutSummary}
 *   - `VendorPayoutListResponseSchema`    → return of {@link listVendorPayouts}
 *   - `VendorPayoutDetailResponseSchema`  → return of {@link getVendorPayout}
 *
 * Hand-mirrored rather than imported to keep NestJS metadata out of the
 * Next bundle (same rationale as `vendor-analytics.ts` and friends). A
 * drift between this and the API DTO surfaces as a typecheck failure on
 * the consumer that reads a field that no longer exists.
 */
import type { ApiClient } from './client.js';

export type VendorPayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'canceled';

export interface VendorPayoutSummary {
  readonly id: string;
  /** ISO calendar date (YYYY-MM-DD). Inclusive lower bound. */
  readonly periodStart: string;
  /** ISO calendar date (YYYY-MM-DD). Exclusive upper bound. */
  readonly periodEnd: string;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly netCents: number;
  readonly status: VendorPayoutStatus;
  readonly scheduledFor: string;
  readonly aeropayPayoutRef: string | null;
  /** ISO-8601 UTC timestamp; null when status is still `pending`. */
  readonly initiatedAt: string | null;
  /** ISO-8601 UTC timestamp; null until the provider settles the payout. */
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface VendorPayoutOrder {
  readonly id: string;
  readonly shortCode: string;
  /** ISO-8601 UTC timestamp when the order flipped to `delivered`. */
  readonly deliveredAt: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly customerFirstName: string | null;
  readonly customerLastName: string | null;
}

export interface VendorPayoutDetail extends VendorPayoutSummary {
  readonly orders: readonly VendorPayoutOrder[];
}

export interface VendorPayoutListResult {
  readonly payouts: readonly VendorPayoutSummary[];
}

export async function listVendorPayouts(client: ApiClient): Promise<VendorPayoutListResult> {
  return client.request<VendorPayoutListResult>('/v1/vendor/payouts');
}

export async function getVendorPayout(
  client: ApiClient,
  payoutId: string,
): Promise<VendorPayoutDetail> {
  return client.request<VendorPayoutDetail>(`/v1/vendor/payouts/${encodeURIComponent(payoutId)}`);
}

/**
 * Payout bank-account link status. Boolean only by design — the underlying
 * Aeropay account ref is a Restricted value that never leaves the API
 * (mirrors `hasAeropayAccount` on the settings surface).
 */
export interface DispensaryBankAccountStatus {
  readonly linked: boolean;
}

export interface DispensaryBankLinkSession {
  readonly id: string;
  readonly hostedUrl: string;
  /** ISO-8601 UTC timestamp. */
  readonly expiresAt: string;
}

export interface StartDispensaryBankLinkResult {
  readonly link: DispensaryBankLinkSession;
}

export async function getVendorBankAccountStatus(
  client: ApiClient,
): Promise<DispensaryBankAccountStatus> {
  return client.request<DispensaryBankAccountStatus>('/v1/vendor/payouts/bank-account');
}

export async function startVendorBankLink(
  client: ApiClient,
  returnUrl: string,
): Promise<StartDispensaryBankLinkResult> {
  return client.request<StartDispensaryBankLinkResult>('/v1/vendor/payouts/bank-account/link', {
    method: 'POST',
    body: { returnUrl },
  });
}
