/**
 * Tests for the pure delivery policy. Two layers:
 *   1. Classification — every template key maps to a category, and only the
 *      two consumer-facing categories are suppressible.
 *   2. Decision — `isNotificationDeliverable` honours the in_app-always,
 *      non-suppressible-always, null-is-all-on, and category-AND-channel
 *      rules for every channel.
 */
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './templates/registry.js';
import {
  NOTIFICATION_CATEGORY_BY_TEMPLATE,
  SUPPRESSIBLE_CATEGORIES,
  categoryForTemplate,
  isCategorySuppressible,
  isNotificationDeliverable,
  type NotificationCategory,
  type NotificationPreferenceState,
} from './preferences.js';
import type { NotificationChannel, NotificationTemplateKey } from './types.js';

const ALL_ON: NotificationPreferenceState = {
  orderUpdatesEnabled: true,
  promotionsEnabled: true,
  pushEnabled: true,
  smsEnabled: true,
  emailEnabled: true,
};

const ALL_OFF: NotificationPreferenceState = {
  orderUpdatesEnabled: false,
  promotionsEnabled: false,
  pushEnabled: false,
  smsEnabled: false,
  emailEnabled: false,
};

describe('NOTIFICATION_CATEGORY_BY_TEMPLATE', () => {
  it('classifies every registered template key (exhaustive, no gaps)', () => {
    const templateKeys = Object.keys(TEMPLATES) as NotificationTemplateKey[];
    for (const key of templateKeys) {
      expect(NOTIFICATION_CATEGORY_BY_TEMPLATE[key]).toBeDefined();
    }
    // And the reverse: no stray keys in the map that aren't real templates.
    expect(Object.keys(NOTIFICATION_CATEGORY_BY_TEMPLATE).sort()).toEqual(templateKeys.sort());
  });

  it('only order_updates and promotions are user-suppressible', () => {
    expect([...SUPPRESSIBLE_CATEGORIES].sort()).toEqual(['order_updates', 'promotions']);
  });

  it('keeps transactional + operational categories out of the suppressible set', () => {
    const nonSuppressible: NotificationCategory[] = ['account', 'driver', 'vendor'];
    for (const category of nonSuppressible) {
      expect(isCategorySuppressible(category)).toBe(false);
    }
  });

  it('routes order lifecycle to order_updates and payment/refund/auth to account', () => {
    expect(categoryForTemplate('order.accepted')).toBe('order_updates');
    expect(categoryForTemplate('order.completed')).toBe('order_updates');
    expect(categoryForTemplate('payment.failed')).toBe('account');
    expect(categoryForTemplate('refund.issued')).toBe('account');
    expect(categoryForTemplate('auth.password_reset')).toBe('account');
    expect(categoryForTemplate('dispensary.new_nearby')).toBe('promotions');
    expect(categoryForTemplate('dispatch.offer')).toBe('driver');
    expect(categoryForTemplate('vendor.payout.completed')).toBe('vendor');
  });
});

describe('isNotificationDeliverable', () => {
  it('always delivers in_app regardless of preferences (it is the inbox record)', () => {
    expect(
      isNotificationDeliverable({
        templateKey: 'order.accepted',
        channel: 'in_app',
        preferences: ALL_OFF,
      }),
    ).toBe(true);
    expect(
      isNotificationDeliverable({
        templateKey: 'dispensary.new_nearby',
        channel: 'in_app',
        preferences: ALL_OFF,
      }),
    ).toBe(true);
  });

  it('always delivers non-suppressible categories on every channel', () => {
    const channels: NotificationChannel[] = ['push', 'sms', 'email', 'in_app'];
    for (const channel of channels) {
      expect(
        isNotificationDeliverable({ templateKey: 'payment.failed', channel, preferences: ALL_OFF }),
      ).toBe(true);
      expect(
        isNotificationDeliverable({ templateKey: 'dispatch.offer', channel, preferences: ALL_OFF }),
      ).toBe(true);
    }
  });

  it('delivers everything when preferences are null (opt-out default)', () => {
    const channels: NotificationChannel[] = ['push', 'sms', 'email', 'in_app'];
    for (const channel of channels) {
      expect(
        isNotificationDeliverable({ templateKey: 'order.accepted', channel, preferences: null }),
      ).toBe(true);
      expect(
        isNotificationDeliverable({
          templateKey: 'dispensary.new_nearby',
          channel,
          preferences: null,
        }),
      ).toBe(true);
    }
  });

  it('suppresses a suppressible category when the category toggle is off', () => {
    const prefs: NotificationPreferenceState = { ...ALL_ON, orderUpdatesEnabled: false };
    expect(
      isNotificationDeliverable({
        templateKey: 'order.accepted',
        channel: 'push',
        preferences: prefs,
      }),
    ).toBe(false);
    expect(
      isNotificationDeliverable({
        templateKey: 'order.accepted',
        channel: 'sms',
        preferences: prefs,
      }),
    ).toBe(false);
    // Promotions unaffected by the order_updates toggle.
    expect(
      isNotificationDeliverable({
        templateKey: 'dispensary.new_nearby',
        channel: 'push',
        preferences: prefs,
      }),
    ).toBe(true);
  });

  it('suppresses a single channel when only that channel toggle is off', () => {
    const prefs: NotificationPreferenceState = { ...ALL_ON, smsEnabled: false };
    expect(
      isNotificationDeliverable({
        templateKey: 'order.picked_up',
        channel: 'push',
        preferences: prefs,
      }),
    ).toBe(true);
    expect(
      isNotificationDeliverable({
        templateKey: 'order.picked_up',
        channel: 'sms',
        preferences: prefs,
      }),
    ).toBe(false);
  });

  it('gates on category AND channel — either off suppresses', () => {
    const categoryOff: NotificationPreferenceState = { ...ALL_ON, orderUpdatesEnabled: false };
    const channelOff: NotificationPreferenceState = { ...ALL_ON, emailEnabled: false };
    expect(
      isNotificationDeliverable({
        templateKey: 'order.completed',
        channel: 'email',
        preferences: categoryOff,
      }),
    ).toBe(false);
    expect(
      isNotificationDeliverable({
        templateKey: 'order.completed',
        channel: 'email',
        preferences: channelOff,
      }),
    ).toBe(false);
    expect(
      isNotificationDeliverable({
        templateKey: 'order.completed',
        channel: 'email',
        preferences: ALL_ON,
      }),
    ).toBe(true);
  });
});
