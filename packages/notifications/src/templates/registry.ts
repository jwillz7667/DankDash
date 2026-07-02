import {
  authIdVerificationRequiredTemplate,
  authPasswordResetTemplate,
  authWelcomeTemplate,
} from './auth.js';
import {
  dispatchCanceledTemplate,
  dispatchOfferExpiredTemplate,
  dispatchOfferTemplate,
} from './dispatch.js';
import { dispensaryNewNearbyTemplate } from './dispensary.js';
import {
  orderAcceptedTemplate,
  orderArrivedTemplate,
  orderArrivingTemplate,
  orderCanceledTemplate,
  orderCompletedTemplate,
  orderDriverAssignedTemplate,
  orderPickedUpTemplate,
  orderPreppingTemplate,
  orderReadyTemplate,
  orderRejectedTemplate,
  paymentFailedTemplate,
  refundIssuedTemplate,
} from './order-lifecycle.js';
import {
  vendorMetrcReconciliationDiscrepancyTemplate,
  vendorNewOrderTemplate,
  vendorPayoutCompletedTemplate,
} from './vendor.js';
import type { TemplatePayloads, TemplateRegistry } from './template.js';
import type { NotificationTemplateKey, RenderedNotification } from '../types.js';

/**
 * The full template registry — one entry per `NotificationTemplateKey`.
 * If you add a key to the union in `types.ts` without adding it here,
 * `tsc` will fail with "missing properties from type TemplateRegistry".
 * If you add an entry without declaring a payload in `TemplatePayloads`,
 * the entry's parameter type collapses to `never` and `render` becomes
 * unusable — also a compile error at the call site.
 */
export const TEMPLATES: TemplateRegistry = {
  'order.accepted': orderAcceptedTemplate,
  'order.prepping': orderPreppingTemplate,
  'order.ready': orderReadyTemplate,
  'order.driver_assigned': orderDriverAssignedTemplate,
  'order.picked_up': orderPickedUpTemplate,
  'order.arriving': orderArrivingTemplate,
  'order.arrived': orderArrivedTemplate,
  'order.completed': orderCompletedTemplate,
  'order.canceled': orderCanceledTemplate,
  'order.rejected': orderRejectedTemplate,
  'payment.failed': paymentFailedTemplate,
  'refund.issued': refundIssuedTemplate,
  'dispensary.new_nearby': dispensaryNewNearbyTemplate,
  'dispatch.offer': dispatchOfferTemplate,
  'dispatch.offer_expired': dispatchOfferExpiredTemplate,
  'dispatch.canceled': dispatchCanceledTemplate,
  'vendor.new_order': vendorNewOrderTemplate,
  'vendor.payout.completed': vendorPayoutCompletedTemplate,
  'vendor.metrc.reconciliation_discrepancy': vendorMetrcReconciliationDiscrepancyTemplate,
  'auth.welcome': authWelcomeTemplate,
  'auth.id_verification_required': authIdVerificationRequiredTemplate,
  'auth.password_reset': authPasswordResetTemplate,
};

/**
 * Type-safe template dispatch. The TS overload resolves the payload
 * shape from the key, so `renderTemplate('order.accepted', {...})`
 * fails to compile if the caller omits `dispensaryName`.
 */
export function renderTemplate<TKey extends NotificationTemplateKey>(
  key: TKey,
  payload: TemplatePayloads[TKey],
): ReadonlyArray<RenderedNotification> {
  return TEMPLATES[key](payload);
}
