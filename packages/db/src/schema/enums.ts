import { pgEnum } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', [
  'customer',
  'budtender',
  'manager',
  'owner',
  'driver',
  'admin',
  'superadmin',
]);

export const userStatus = pgEnum('user_status', ['pending_kyc', 'active', 'suspended', 'banned']);

export const idDocumentType = pgEnum('id_document_type', [
  'drivers_license',
  'passport',
  'state_id',
  'military_id',
  'tribal_id',
]);

export const licenseType = pgEnum('license_type', [
  'retailer',
  'microbusiness',
  'mezzobusiness',
  'medical_combo',
  'delivery_service',
  'lphe_retailer',
]);

export const dispensaryStatus = pgEnum('dispensary_status', [
  'onboarding',
  'active',
  'paused',
  'terminated',
]);

export const posProvider = pgEnum('pos_provider', [
  'dutchie',
  'flowhub',
  'treez',
  'greenbits',
  'cova',
  'manual',
]);

export const staffRole = pgEnum('staff_role', ['budtender', 'manager', 'owner']);

/**
 * The kinds of entity a consumer can save to their favorites. Drives the
 * `user_favorites.favoritable_type` discriminator; the exclusive-arc CHECK on
 * that table ties each value to exactly one populated FK column.
 */
export const favoritableType = pgEnum('favoritable_type', ['dispensary', 'product']);

export const productType = pgEnum('product_type', [
  'flower',
  'preroll',
  'infused_preroll',
  'vape',
  'edible',
  'beverage',
  'concentrate',
  'tincture',
  'topical',
  'accessory',
  'seed',
  'clone',
]);

export const strainType = pgEnum('strain_type', ['indica', 'sativa', 'hybrid', 'cbd', 'balanced']);

export const orderStatus = pgEnum('order_status', [
  'placed',
  'payment_failed',
  'accepted',
  'rejected',
  'prepping',
  'ready_for_pickup',
  'awaiting_driver',
  'dispatch_failed',
  'driver_assigned',
  'en_route_pickup',
  'picked_up',
  'en_route_dropoff',
  'arrived_at_dropoff',
  'id_scan_pending',
  'id_scan_passed',
  'id_scan_failed',
  'delivered',
  'returned_to_store',
  'canceled',
  'disputed',
]);

export const paymentMethodType = pgEnum('payment_method_type', ['aeropay_ach', 'cash']);

export const paymentMethodStatus = pgEnum('payment_method_status', [
  'pending',
  'active',
  'failed',
  'revoked',
]);

export const paymentStatus = pgEnum('payment_status', [
  'initiated',
  'authorized',
  'settled',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
]);

export const ledgerAccountType = pgEnum('ledger_account_type', [
  'customer',
  'dispensary',
  'driver',
  'platform_revenue',
  'cannabis_tax',
  'sales_tax',
  'aeropay_clearing',
  'refund_reserve',
]);

export const payoutRecipient = pgEnum('payout_recipient', ['dispensary', 'driver']);

export const payoutStatus = pgEnum('payout_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'canceled',
]);

export const refundStatus = pgEnum('refund_status', ['pending', 'completed', 'failed', 'canceled']);

export const driverStatus = pgEnum('driver_status', [
  'offline',
  'online',
  'en_route_pickup',
  'en_route_dropoff',
  'on_break',
  'unavailable',
]);

export const offerStatus = pgEnum('offer_status', ['offered', 'accepted', 'declined', 'expired']);

export const complianceCheckType = pgEnum('compliance_check_type', [
  'age',
  'hours',
  'per_transaction_limit',
  'delivery_geofence',
  'id_scan',
  'license_validity',
  'product_provenance',
]);

export const metrcStatus = pgEnum('metrc_status', ['pending', 'reported', 'failed', 'reconciled']);

export const verificationContext = pgEnum('verification_context', [
  'signup',
  'delivery_handoff',
  'periodic_recheck',
]);

export const notificationChannel = pgEnum('notification_channel', [
  'push',
  'sms',
  'email',
  'in_app',
]);

export const promoCodeType = pgEnum('promo_code_type', [
  'percent',
  'fixed_amount',
  'free_delivery',
]);

export const promoCodeScope = pgEnum('promo_code_scope', ['platform', 'dispensary']);

/**
 * Who absorbs a promo discount at settlement. A promo's scope IS its funder:
 * a platform-scoped code reduces the platform's revenue leg, a
 * dispensary-scoped code reduces that dispensary's payout leg. Stored on the
 * order as a snapshot so the settlement path never has to join back to the
 * promo to route the money.
 */
export const discountFundedBy = pgEnum('discount_funded_by', ['platform', 'dispensary']);

/**
 * Mirror of every enum's string-literal union for use in app code
 * (eg. `OrderStatus = 'placed' | 'accepted' | ...`). Drizzle's `.enumValues`
 * field carries the tuple at the type level; we widen it to a const tuple
 * here so consumers do not need to reach into Drizzle internals.
 */
export type UserRole = (typeof userRole.enumValues)[number];
export type UserStatus = (typeof userStatus.enumValues)[number];
export type IdDocumentType = (typeof idDocumentType.enumValues)[number];
export type LicenseType = (typeof licenseType.enumValues)[number];
export type DispensaryStatus = (typeof dispensaryStatus.enumValues)[number];
export type PosProvider = (typeof posProvider.enumValues)[number];
export type StaffRole = (typeof staffRole.enumValues)[number];
export type ProductType = (typeof productType.enumValues)[number];
export type StrainType = (typeof strainType.enumValues)[number];
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type PaymentMethodType = (typeof paymentMethodType.enumValues)[number];
export type PaymentMethodStatus = (typeof paymentMethodStatus.enumValues)[number];
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
export type LedgerAccountType = (typeof ledgerAccountType.enumValues)[number];
export type PayoutRecipient = (typeof payoutRecipient.enumValues)[number];
export type PayoutStatus = (typeof payoutStatus.enumValues)[number];
export type RefundStatus = (typeof refundStatus.enumValues)[number];
export type DriverStatus = (typeof driverStatus.enumValues)[number];
export type OfferStatus = (typeof offerStatus.enumValues)[number];
export type ComplianceCheckType = (typeof complianceCheckType.enumValues)[number];
export type MetrcStatus = (typeof metrcStatus.enumValues)[number];
export type VerificationContext = (typeof verificationContext.enumValues)[number];
export type NotificationChannel = (typeof notificationChannel.enumValues)[number];
export type PromoCodeType = (typeof promoCodeType.enumValues)[number];
export type PromoCodeScope = (typeof promoCodeScope.enumValues)[number];
export type DiscountFundedBy = (typeof discountFundedBy.enumValues)[number];
