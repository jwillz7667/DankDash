/**
 * Public surface of @dankdash/notifications.
 *
 * The package decomposes notification delivery into three pieces:
 *   1. Templates — pure functions keyed by `templateKey` that turn a typed
 *      `payload` into a `RenderedNotification` per channel. Templates have
 *      no side effects, so they can run inside the API enqueue path or in
 *      the worker delivery cron without changing behavior.
 *   2. Providers — thin adapters around APNs / Twilio / Resend that take a
 *      `RenderedNotification` and a typed `Recipient` and produce a
 *      `ProviderSendResult`. The provider boundary is the only place that
 *      touches the network.
 *   3. NotificationsRepository (in @dankdash/db) — the queue. The dispatcher
 *      writes a row with `payload`/`templateKey`/`channel` and the worker
 *      polls `sentAt IS NULL AND error IS NULL` to actually fan out.
 *
 * Keeping each layer typed lets the API enqueue without importing Twilio,
 * and lets the worker deliver without importing Nest. Both processes share
 * this `types.ts` and the template registry only.
 */

/**
 * Channels that templates can render into and providers can deliver on.
 * Mirrors `notificationChannel` in @dankdash/db. Declared here as a pure
 * string literal union so neither side has to import the Drizzle schema —
 * iOS / CI / scripts can pull this in without dragging Postgres in.
 */
export type NotificationChannel = 'push' | 'sms' | 'email' | 'in_app';

/**
 * Catalog of event keys a template is registered against. The string
 * itself is what lands in `notifications.template_key`, so renaming an
 * entry here is a wire change — bump and dual-write if you ever do it.
 *
 * The list is the spec §5.1 minimum plus the driver / vendor / admin
 * variants the wider event graph needs.
 */
export type NotificationTemplateKey =
  // Consumer order lifecycle (§5.1 the ten in the spec).
  | 'order.accepted'
  | 'order.prepping'
  | 'order.ready'
  | 'order.picked_up'
  | 'order.arriving'
  | 'order.arrived'
  | 'order.completed'
  | 'payment.failed'
  | 'refund.issued'
  | 'dispensary.new_nearby'
  // Driver-side events (DankDasher app — push only).
  | 'dispatch.offer'
  | 'dispatch.offer_expired'
  | 'dispatch.canceled'
  // Vendor-side events (portal email).
  | 'vendor.payout.completed'
  | 'vendor.metrc.reconciliation_discrepancy'
  // Account / onboarding.
  | 'auth.welcome'
  | 'auth.id_verification_required'
  | 'auth.password_reset';

/**
 * Recipient envelope — every provider call needs at minimum a user id (for
 * the persistence row) and the channel-specific destination. The fields
 * are deliberately discriminated by `channel` so a typo at the dispatch
 * site (passing an email to APNs) is a compile error, not a 4XX from
 * Twilio at 03:00.
 */
export type Recipient =
  | {
      readonly channel: 'push';
      readonly userId: string;
      readonly apnsTokens: ReadonlyArray<string>;
      readonly bundleId: string;
    }
  | {
      readonly channel: 'sms';
      readonly userId: string;
      readonly phoneE164: string;
    }
  | {
      readonly channel: 'email';
      readonly userId: string;
      readonly emailAddress: string;
    }
  | {
      readonly channel: 'in_app';
      readonly userId: string;
    };

/**
 * Channel-shaped renderings. A single template may produce several of
 * these (e.g. an order arrival both pushes and writes an in-app row) and
 * the dispatcher fans out per channel.
 */
export type RenderedNotification =
  | RenderedPushNotification
  | RenderedSmsNotification
  | RenderedEmailNotification
  | RenderedInAppNotification;

export interface RenderedPushNotification {
  readonly channel: 'push';
  readonly title: string;
  readonly body: string;
  /**
   * APNs payload extension surfaced under `aps` — opaque to the provider,
   * delivered to the app via `userInfo`. Used by the consumer/driver iOS
   * apps to deep-link into the correct screen.
   */
  readonly data: Readonly<Record<string, string>>;
  /**
   * Suppresses notification UI on the device when true — used for silent
   * background updates (e.g. dispatch cancellation that just needs the app
   * to re-fetch state).
   */
  readonly contentAvailable: boolean;
  /**
   * APNs `apns-collapse-id`. Set when multiple notifications about the
   * same order should replace each other on the lock screen rather than
   * stack (e.g. "Arriving in 5 min" → "Arriving now" should collapse).
   */
  readonly collapseId?: string;
}

export interface RenderedSmsNotification {
  readonly channel: 'sms';
  /** Pre-rendered message body. ≤ 1600 chars per Twilio guidance; templates enforce. */
  readonly body: string;
}

export interface RenderedEmailNotification {
  readonly channel: 'email';
  readonly subject: string;
  /** Plain-text fallback; required so Resend always has a text/plain part. */
  readonly text: string;
  /** Pre-rendered HTML body. May be undefined for ops-only notifications. */
  readonly html?: string;
  /** Overrides the default `RESEND_FROM_EMAIL` for ops/admin routing. */
  readonly fromOverride?: string;
}

export interface RenderedInAppNotification {
  readonly channel: 'in_app';
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
}

/**
 * Result returned by a `NotificationProvider.send`. Mirrors the columns
 * the dispatcher writes back into `notifications`:
 *   - `ok`     → set `sent_at = now()`, `provider_ref = <id>`
 *   - `error`  → write `error` and gate retry on `retryable`
 *
 * `retryable: false` is a poison-pill signal — the dispatcher must NOT
 * re-enqueue. Today the only producer is APNs BadDeviceToken (also
 * triggers `pushTokens.deactivateByApnsToken` so the next attempt skips
 * the dead token entirely).
 */
export type ProviderSendResult =
  | {
      readonly ok: true;
      readonly providerRef: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retryable: boolean;
      /**
       * APNs `device_token` that the upstream rejected as invalid. When
       * present the dispatcher retires the token via the push-tokens
       * repository so a redelivery never picks it up again.
       */
      readonly retireApnsToken?: string;
    };
