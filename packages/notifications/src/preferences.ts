/**
 * Notification delivery policy — pure, framework-free, DB-free.
 *
 * This module answers one question: given a template key, a channel, and the
 * user's saved preferences, should this notification be delivered?
 *
 * It lives in @dankdash/notifications (not the API) so the policy is shared
 * with the worker delivery path and is unit-testable without Nest, Postgres,
 * or Redis. The DB owns the *storage* of preferences (one row per user); this
 * module owns the *decision*.
 *
 * Two-axis model:
 *   • category — which kind of notification (order updates, promotions, …).
 *     Only `SUPPRESSIBLE_CATEGORIES` can ever be turned off by a user.
 *     Everything else is transactional (payment/refund/auth) or operational
 *     (driver dispatch, vendor ops) and must always be delivered.
 *   • channel — push / sms / email. `in_app` is never suppressible: it is the
 *     in-app inbox record and is always written.
 */
import type { NotificationChannel, NotificationTemplateKey } from './types.js';

/**
 * Coarse grouping over `NotificationTemplateKey`. The consumer app only ever
 * exposes toggles for the suppressible categories; the rest exist so the map
 * below is exhaustive and the dispatcher can reason about every template.
 */
export type NotificationCategory = 'order_updates' | 'promotions' | 'account' | 'driver' | 'vendor';

/**
 * Exhaustive template → category map. `Record<NotificationTemplateKey, …>`
 * makes this break `tsc` the moment a new template key is added to the union
 * in `types.ts` without classifying it here — the same compile-time
 * enforcement the template registry uses. Never let a key default silently to
 * a suppressible category: an unclassified transactional message that gets
 * dropped is a far worse failure than a promo that leaks.
 */
export const NOTIFICATION_CATEGORY_BY_TEMPLATE: Readonly<
  Record<NotificationTemplateKey, NotificationCategory>
> = {
  'order.accepted': 'order_updates',
  'order.prepping': 'order_updates',
  'order.ready': 'order_updates',
  'order.driver_assigned': 'order_updates',
  'order.picked_up': 'order_updates',
  'order.arriving': 'order_updates',
  'order.arrived': 'order_updates',
  'order.completed': 'order_updates',
  'order.canceled': 'order_updates',
  'order.rejected': 'order_updates',
  'payment.failed': 'account',
  'refund.issued': 'account',
  'dispensary.new_nearby': 'promotions',
  'dispatch.offer': 'driver',
  'dispatch.offer_expired': 'driver',
  'dispatch.canceled': 'driver',
  'vendor.new_order': 'vendor',
  'vendor.payout.completed': 'vendor',
  'vendor.metrc.reconciliation_discrepancy': 'vendor',
  'auth.welcome': 'account',
  'auth.id_verification_required': 'account',
  'auth.password_reset': 'account',
};

/**
 * The only categories a user can switch off. Everything outside this set is
 * delivered unconditionally regardless of stored preferences:
 *   • account — payment failures, refunds, auth/security. Money + account
 *     safety; suppressing these would strand users.
 *   • driver  — dispatch offers/cancels on the DankDasher app. Operational;
 *     a driver can't opt out of the job feed.
 *   • vendor  — payout + Metrc reconciliation on the portal. Compliance + ops.
 */
export const SUPPRESSIBLE_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'order_updates',
  'promotions',
]);

/**
 * The minimal preference shape the policy needs — mirrors the boolean columns
 * on `notification_preferences` but declared here so the policy doesn't import
 * the Drizzle row type (keeps the package DB-free). The API maps its DB row
 * onto this structurally.
 */
export interface NotificationPreferenceState {
  readonly orderUpdatesEnabled: boolean;
  readonly promotionsEnabled: boolean;
  readonly pushEnabled: boolean;
  readonly smsEnabled: boolean;
  readonly emailEnabled: boolean;
}

export function categoryForTemplate(templateKey: NotificationTemplateKey): NotificationCategory {
  return NOTIFICATION_CATEGORY_BY_TEMPLATE[templateKey];
}

export function isCategorySuppressible(category: NotificationCategory): boolean {
  return SUPPRESSIBLE_CATEGORIES.has(category);
}

/**
 * Pure delivery decision. Returns `true` when a rendered (templateKey,
 * channel) pair should be delivered for a user with the given preferences.
 *
 * Rules, evaluated in order:
 *   1. `in_app` is the inbox record — always deliver, never suppressible.
 *   2. Non-suppressible category — always deliver on every channel.
 *   3. `preferences === null` (user never saved any) — deliver everything.
 *      Preferences are opt-out, not opt-in, so silence means "all on".
 *   4. Otherwise gate on BOTH the category toggle AND the channel toggle:
 *      either being off suppresses the delivery.
 */
export function isNotificationDeliverable(input: {
  readonly templateKey: NotificationTemplateKey;
  readonly channel: NotificationChannel;
  readonly preferences: NotificationPreferenceState | null;
}): boolean {
  const { channel, templateKey, preferences } = input;

  if (channel === 'in_app') return true;

  const category = categoryForTemplate(templateKey);
  if (!isCategorySuppressible(category)) return true;

  if (preferences === null) return true;

  const categoryEnabled =
    category === 'order_updates' ? preferences.orderUpdatesEnabled : preferences.promotionsEnabled;
  if (!categoryEnabled) return false;

  switch (channel) {
    case 'push':
      return preferences.pushEnabled;
    case 'sms':
      return preferences.smsEnabled;
    case 'email':
      return preferences.emailEnabled;
  }
}
