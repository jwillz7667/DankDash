import type { NotificationTemplateKey, RenderedNotification } from '../types.js';

/**
 * Template payload contract. Templates are pure functions keyed by a
 * `NotificationTemplateKey`; the payload shape per key is declared in
 * `TemplatePayloads` so callers get a compile error if they enqueue
 * `order.accepted` without an `orderId`. Snapshot tests pin the
 * rendered output so wording changes are reviewable, not silent.
 */
export interface TemplatePayloads {
  // Consumer order lifecycle.
  'order.accepted': {
    readonly orderId: string;
    readonly dispensaryName: string;
    readonly etaMinutes?: number;
  };
  'order.prepping': {
    readonly orderId: string;
    readonly dispensaryName: string;
  };
  'order.ready': {
    readonly orderId: string;
    readonly dispensaryName: string;
  };
  'order.picked_up': {
    readonly orderId: string;
    readonly driverFirstName: string;
  };
  'order.arriving': {
    readonly orderId: string;
    readonly driverFirstName: string;
    readonly etaMinutes: number;
  };
  'order.arrived': {
    readonly orderId: string;
    readonly driverFirstName: string;
  };
  'order.completed': {
    readonly orderId: string;
    readonly totalCents: number;
  };
  'payment.failed': {
    readonly orderId: string;
    readonly amountCents: number;
    readonly reason: string;
  };
  'refund.issued': {
    readonly orderId: string;
    readonly amountCents: number;
    readonly reason: string;
  };
  'dispensary.new_nearby': {
    readonly dispensaryId: string;
    readonly dispensaryName: string;
    readonly distanceMiles: number;
  };
  // Driver app.
  'dispatch.offer': {
    readonly offerId: string;
    readonly orderId: string;
    readonly dispensaryName: string;
    readonly distanceMiles: number;
    readonly expiresInSeconds: number;
  };
  'dispatch.offer_expired': {
    readonly offerId: string;
    readonly orderId: string;
  };
  'dispatch.canceled': {
    readonly orderId: string;
    readonly reason: string;
  };
  // Vendor portal.
  'vendor.payout.completed': {
    readonly payoutId: string;
    readonly amountCents: number;
    readonly periodEnd: string;
  };
  'vendor.metrc.reconciliation_discrepancy': {
    readonly dispensaryName: string;
    readonly discrepancyCount: number;
    readonly kinds: ReadonlyArray<string>;
  };
  // Account / onboarding.
  'auth.welcome': {
    readonly firstName: string;
  };
  'auth.id_verification_required': {
    readonly reason: string;
  };
  'auth.password_reset': {
    /** The single-use reset code, pre-formatted for display (e.g. `ABCDE-FGHJK`). */
    readonly code: string;
    readonly expiresInMinutes: number;
  };
}

/**
 * Strongly-typed template function. Each entry in the registry takes a
 * payload narrowed to its key and returns one rendered notification per
 * channel it fans out to (e.g. order.arriving renders both push + SMS).
 */
export type Template<TKey extends NotificationTemplateKey> = (
  payload: TemplatePayloads[TKey],
) => ReadonlyArray<RenderedNotification>;

/**
 * Registry mapping every notification key to its renderer. The mapped
 * type uses `Required` over `NotificationTemplateKey` so removing a key
 * from the union without updating the registry is a `tsc` failure, and
 * adding a key to the union without registering a renderer is also a
 * compile error. The registry itself is constructed in `registry.ts`.
 */
export type TemplateRegistry = {
  readonly [K in NotificationTemplateKey]: Template<K>;
};
