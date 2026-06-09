/**
 * NotificationDispatcher — the single fan-out chokepoint that every
 * notification event flows through, regardless of which listener
 * triggered it.
 *
 * Responsibilities (per spec §5):
 *   1. **Dedup at the boundary.** Before any work, atomically reserve a
 *      per-(user, templateKey, eventId) key in Redis with a 24h TTL.
 *      Failure to acquire means a duplicate ORDER_TRANSITIONED_EVENT
 *      (or webhook replay) already fired this notification — skip
 *      silently. Without this, every NestJS event-bus reset or webhook
 *      retry would double-push.
 *   2. **Render once.** Pure template render via `renderTemplate()`. The
 *      payload is type-checked at the call site through `TemplatePayloads`.
 *   3. **Fan out per channel.** Each `RenderedNotification` is delivered
 *      through the channel's provider (APNs/Twilio/Resend) or, for
 *      `in_app`, persisted directly. Channels with no configured
 *      provider produce a `provider_unavailable` row so the gap is
 *      visible to ops instead of silently dropping.
 *   4. **Record every attempt.** Every channel produces exactly one
 *      `notifications` row — sentAt+providerRef on success, error on
 *      failure. The row is the audit trail; nobody else writes to
 *      `notifications`.
 *   5. **Retire dead APNs tokens.** When the APNs provider reports a
 *      `retireApnsToken`, the dispatcher flips the matching row in
 *      `push_tokens` to `is_active = false` so the next attempt doesn't
 *      pick it up again. The iOS app re-registers on next launch.
 *
 * Concurrency: listeners that call this dispatcher (`@OnEvent` handlers)
 * never await the promise — the in-process event bus discards it. That
 * is intentional: the order transition is already durable when the
 * event fires; the notification path has a tens-of-seconds budget and
 * must not block the HTTP response. Errors are caught and logged; the
 * row stays in `notifications` with `error` set for the worker (Phase
 * 12.5 redelivery; currently no automatic retry).
 *
 * Why not a separate "outbox" + worker for delivery: the spec's
 * notification fan-out is inline by design — the iOS app subscribes to
 * the `notifications` table via realtime push (Socket.io room), so the
 * row insertion IS the consumer-visible artifact. The provider call is
 * an opportunistic side effect; if it fails, the row carries the error
 * and the in-app surface still works.
 */
import {
  type NotificationPreference,
  type NotificationPreferencesRepository,
  type NotificationsRepository,
  type PushTokensRepository,
  type UsersRepository,
} from '@dankdash/db';
import {
  isNotificationDeliverable,
  renderTemplate,
  type NotificationPreferenceState,
  type NotificationProvider,
  type NotificationTemplateKey,
  type ProviderSendResult,
  type Recipient,
  type RenderedNotification,
  type TemplatePayloads,
} from '@dankdash/notifications';
import { Injectable, Logger } from '@nestjs/common';
import type { NotificationDedupeStore } from './notification-dedupe.store.js';

export type PushAppVariant = 'consumer' | 'driver';

export interface NotificationDispatcherConfig {
  /**
   * APNs topic (bundle id) per app variant. Distinct bundles for the
   * consumer + driver iOS apps; both live under the dankdash team.
   * Vendor portal is web-only — no entry here.
   */
  readonly apnsBundleIdByAppVariant: Readonly<Record<PushAppVariant, string>>;
  /** Idempotency window, per spec §5.2. */
  readonly dedupeTtlSeconds: number;
}

export interface NotificationDispatcherDeps {
  readonly config: NotificationDispatcherConfig;
  readonly dedupe: NotificationDedupeStore;
  readonly notifications: NotificationsRepository;
  readonly notificationPreferences: NotificationPreferencesRepository;
  readonly pushTokens: PushTokensRepository;
  readonly users: UsersRepository;
  /** Provider table. Any channel without a provider records `provider_unavailable`. */
  readonly pushProvider?: NotificationProvider;
  readonly smsProvider?: NotificationProvider;
  readonly emailProvider?: NotificationProvider;
}

export interface DispatchInput<TKey extends NotificationTemplateKey> {
  readonly userId: string;
  readonly templateKey: TKey;
  readonly payload: TemplatePayloads[TKey];
  readonly appVariant: PushAppVariant;
  /**
   * Stable identifier for the originating event (e.g. orderId + toStatus
   * for transitions, refundId for refund webhooks). Combined with userId
   * and templateKey to form the dedup key.
   */
  readonly idempotencyKey: string;
}

export type DispatchOutcome =
  | { readonly skipped: true; readonly reason: 'duplicate' | 'user_not_found' }
  | { readonly skipped: false; readonly results: ReadonlyArray<DispatchChannelResult> };

export interface DispatchChannelResult {
  readonly channel: RenderedNotification['channel'];
  /**
   * The persisted `notifications` row id, or `null` when the channel was
   * suppressed by the user's preferences — a suppressed delivery is an
   * intentional user choice, not a failed attempt, so it writes no row (which
   * also keeps the in-app inbox, read from `notifications`, free of opt-out
   * noise).
   */
  readonly notificationId: string | null;
  readonly outcome:
    | ProviderSendResult
    | { readonly ok: false; readonly error: string }
    | { readonly ok: false; readonly suppressed: true };
}

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(private readonly deps: NotificationDispatcherDeps) {}

  async dispatch<TKey extends NotificationTemplateKey>(
    input: DispatchInput<TKey>,
  ): Promise<DispatchOutcome> {
    const dedupKey = `${input.userId}:${input.templateKey}:${input.idempotencyKey}`;
    const acquired = await this.deps.dedupe.acquire(dedupKey, this.deps.config.dedupeTtlSeconds);
    if (!acquired) {
      this.logger.debug(`notifications: dedup hit for ${dedupKey}`);
      return { skipped: true, reason: 'duplicate' };
    }

    const user = await this.deps.users.findById(input.userId);
    if (user === null) {
      this.logger.warn(
        `notifications: user ${input.userId} not found, skipping ${input.templateKey}`,
      );
      return { skipped: true, reason: 'user_not_found' };
    }

    const rendered = renderTemplate(input.templateKey, input.payload);

    // One preferences lookup per dispatch, shared across every rendered
    // channel. A missing row is the common case (most users never open the
    // settings screen) and resolves to deliver-everything in the policy.
    const preferenceRow = await this.deps.notificationPreferences.findByUserId(input.userId);
    const preferences = preferenceRow === null ? null : toPreferenceState(preferenceRow);

    const results: DispatchChannelResult[] = [];
    for (const notification of rendered) {
      if (
        !isNotificationDeliverable({
          templateKey: input.templateKey,
          channel: notification.channel,
          preferences,
        })
      ) {
        this.logger.debug(
          `notifications: suppressed ${notification.channel} for ${input.templateKey} (user ${input.userId} preference)`,
        );
        results.push({
          channel: notification.channel,
          notificationId: null,
          outcome: { ok: false, suppressed: true },
        });
        continue;
      }

      const result = await this.deliverOne({
        userId: input.userId,
        templateKey: input.templateKey,
        appVariant: input.appVariant,
        userEmail: user.email,
        userPhone: user.phone,
        rendered: notification,
      });
      results.push(result);
    }
    return { skipped: false, results };
  }

  private async deliverOne(input: {
    readonly userId: string;
    readonly templateKey: NotificationTemplateKey;
    readonly appVariant: PushAppVariant;
    readonly userEmail: string;
    readonly userPhone: string | null;
    readonly rendered: RenderedNotification;
  }): Promise<DispatchChannelResult> {
    const { rendered } = input;

    // Persist the queue row up front with a placeholder payload — every
    // channel writes one row regardless of outcome. The provider call
    // updates the row in place.
    const row = await this.deps.notifications.create({
      userId: input.userId,
      channel: rendered.channel,
      templateKey: input.templateKey,
      payload: serializeRendered(rendered),
    });

    const recipient = await this.resolveRecipient({
      userId: input.userId,
      appVariant: input.appVariant,
      channel: rendered.channel,
      email: input.userEmail,
      phone: input.userPhone,
    });

    if (recipient === null) {
      const error = `no recipient for channel ${rendered.channel}`;
      await this.deps.notifications.markFailed(row.id, error);
      return { channel: rendered.channel, notificationId: row.id, outcome: { ok: false, error } };
    }

    if (rendered.channel === 'in_app') {
      // No provider call — the row IS the artifact. Mark sent so the
      // iOS in-app inbox shows it on the next /me/notifications poll.
      await this.deps.notifications.markSent(row.id, 'in_app');
      return {
        channel: 'in_app',
        notificationId: row.id,
        outcome: { ok: true, providerRef: 'in_app' },
      };
    }

    const provider = this.providerFor(rendered.channel);
    if (provider === undefined) {
      const error = `provider unavailable for channel ${rendered.channel}`;
      this.logger.warn(`notifications: ${error} (notification ${row.id})`);
      await this.deps.notifications.markFailed(row.id, error);
      return { channel: rendered.channel, notificationId: row.id, outcome: { ok: false, error } };
    }

    const result = await provider.send(recipient, rendered);
    if (result.ok) {
      await this.deps.notifications.markSent(row.id, result.providerRef);
    } else {
      await this.deps.notifications.markFailed(row.id, result.error);
      if (result.retireApnsToken !== undefined) {
        const deactivated = await this.deps.pushTokens.deactivateByApnsToken(
          result.retireApnsToken,
        );
        if (deactivated > 0) {
          this.logger.log(
            `notifications: retired ${String(deactivated)} apns token(s) after ${result.error}`,
          );
        }
      }
    }
    return { channel: rendered.channel, notificationId: row.id, outcome: result };
  }

  private providerFor(channel: RenderedNotification['channel']): NotificationProvider | undefined {
    switch (channel) {
      case 'push':
        return this.deps.pushProvider;
      case 'sms':
        return this.deps.smsProvider;
      case 'email':
        return this.deps.emailProvider;
      case 'in_app':
        return undefined;
    }
  }

  private async resolveRecipient(input: {
    readonly userId: string;
    readonly appVariant: PushAppVariant;
    readonly channel: RenderedNotification['channel'];
    readonly email: string;
    readonly phone: string | null;
  }): Promise<Recipient | null> {
    switch (input.channel) {
      case 'push': {
        const tokens = await this.deps.pushTokens.listActiveForUser(input.userId, input.appVariant);
        if (tokens.length === 0) return null;
        return {
          channel: 'push',
          userId: input.userId,
          apnsTokens: tokens.map((t) => t.apnsToken),
          bundleId: this.deps.config.apnsBundleIdByAppVariant[input.appVariant],
        };
      }
      case 'sms': {
        if (input.phone === null) return null;
        return { channel: 'sms', userId: input.userId, phoneE164: input.phone };
      }
      case 'email':
        return { channel: 'email', userId: input.userId, emailAddress: input.email };
      case 'in_app':
        return { channel: 'in_app', userId: input.userId };
    }
  }
}

/**
 * Projects the persisted preferences row onto the pure policy's structural
 * shape. Kept narrow on purpose: the policy must not see `userId`, timestamps,
 * or the row id, so a future column can't accidentally leak into a delivery
 * decision.
 */
function toPreferenceState(row: NotificationPreference): NotificationPreferenceState {
  return {
    orderUpdatesEnabled: row.orderUpdatesEnabled,
    promotionsEnabled: row.promotionsEnabled,
    pushEnabled: row.pushEnabled,
    smsEnabled: row.smsEnabled,
    emailEnabled: row.emailEnabled,
  };
}

function serializeRendered(rendered: RenderedNotification): Record<string, unknown> {
  // Drizzle's jsonb column types want a plain object; spread to detach
  // from the readonly view and to drop any non-enumerable provider-
  // specific extras that might be attached upstream.
  switch (rendered.channel) {
    case 'push':
      return {
        channel: rendered.channel,
        title: rendered.title,
        body: rendered.body,
        data: { ...rendered.data },
        contentAvailable: rendered.contentAvailable,
        ...(rendered.collapseId !== undefined ? { collapseId: rendered.collapseId } : {}),
      };
    case 'sms':
      return { channel: rendered.channel, body: rendered.body };
    case 'email':
      return {
        channel: rendered.channel,
        subject: rendered.subject,
        text: rendered.text,
        ...(rendered.html !== undefined ? { html: rendered.html } : {}),
        ...(rendered.fromOverride !== undefined ? { fromOverride: rendered.fromOverride } : {}),
      };
    case 'in_app':
      return {
        channel: rendered.channel,
        title: rendered.title,
        body: rendered.body,
        data: { ...rendered.data },
      };
  }
}
