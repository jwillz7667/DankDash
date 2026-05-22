import apn from '@parse/node-apn';
import type {
  ProviderSendResult,
  Recipient,
  RenderedNotification,
  RenderedPushNotification,
} from '../types.js';
import type { NotificationProvider } from './provider.js';

/**
 * Reasons returned by APNs (`response.reason`) that indicate the device
 * token is permanently dead. The dispatcher converts these into
 * `retireApnsToken` so the next attempt skips the token and the row in
 * `push_tokens` is flipped to `is_active = false`.
 *
 * Apple's reference list: see "Handling notification responses from APNs"
 * — https://developer.apple.com/documentation/usernotifications/handling_notification_responses_from_apns
 */
const APNS_DEAD_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
]);

export interface ApnsProviderConfig {
  readonly keyId: string;
  readonly teamId: string;
  /**
   * The Apple-issued .p8 private key contents. Pass the decoded PEM as a
   * `Buffer` (the API composition root pulls it via
   * `Buffer.from(env.APNS_PRIVATE_KEY_BASE64, 'base64')`).
   */
  readonly privateKey: Buffer | string;
  /** When false, targets sandbox APNs. Set true for App Store builds. */
  readonly production: boolean;
  /**
   * Optional provider override — primarily for tests that need to inject
   * a stub. Production callers leave undefined and let the constructor
   * build the real `apn.Provider`.
   */
  readonly provider?: ApnsProviderHandle;
}

/**
 * Narrowed shape of `apn.Provider` we actually rely on — gives tests a
 * lightweight stub surface without having to mock the EventEmitter base
 * class or the full SDK.
 */
export interface ApnsProviderHandle {
  send(
    notification: apn.Notification,
    recipients: string | string[],
  ): Promise<apn.Responses<apn.ResponseSent, apn.ResponseFailure>>;
  shutdown(callback?: () => void): Promise<void>;
}

export class ApnsProvider implements NotificationProvider {
  public readonly channel = 'push' as const;
  private readonly provider: ApnsProviderHandle;

  constructor(config: ApnsProviderConfig) {
    this.provider =
      config.provider ??
      new apn.Provider({
        token: { key: config.privateKey, keyId: config.keyId, teamId: config.teamId },
        production: config.production,
      });
  }

  async send(recipient: Recipient, rendered: RenderedNotification): Promise<ProviderSendResult> {
    if (recipient.channel !== 'push') {
      throw new TypeError(
        `ApnsProvider only handles push recipients, got channel=${recipient.channel}`,
      );
    }
    if (rendered.channel !== 'push') {
      throw new TypeError(
        `ApnsProvider only handles push rendered payloads, got channel=${rendered.channel}`,
      );
    }
    if (recipient.apnsTokens.length === 0) {
      // The composition root filters out users with no active tokens
      // before enqueueing; surfacing this as a non-retryable failure lets
      // the worker mark the row failed without retrying forever.
      return {
        ok: false,
        error: 'no apns tokens for recipient',
        retryable: false,
      };
    }

    const notification = this.buildNotification(recipient.bundleId, rendered);

    const result = await this.provider.send(notification, [...recipient.apnsTokens]);

    if (result.failed.length === 0 && result.sent.length > 0) {
      const first = result.sent[0];
      // `Responses<R,F>` types `sent` as `R[]`; the success path always
      // populates at least one entry alongside `failed.length === 0`, so
      // the first read is well-defined. The fallback to bundleId keeps
      // the provider_ref column from going null when an older mock
      // shape omits the device echo.
      return {
        ok: true,
        providerRef: first?.device ?? recipient.bundleId,
      };
    }

    const failure = result.failed[0];
    if (failure === undefined) {
      // Defensive: every send to N tokens should populate sent+failed to
      // length N. If neither bucket has entries, treat as a transient
      // upstream issue so the row gets retried.
      return {
        ok: false,
        error: 'apns returned no result',
        retryable: true,
      };
    }

    const reason = failure.response?.reason ?? failure.error?.message ?? 'unknown apns failure';
    const isDeadToken =
      failure.response?.reason !== undefined &&
      APNS_DEAD_TOKEN_REASONS.has(failure.response.reason);

    if (isDeadToken) {
      return {
        ok: false,
        error: `apns rejected token: ${reason}`,
        retryable: false,
        retireApnsToken: failure.device,
      };
    }

    return {
      ok: false,
      error: `apns failure: ${reason}`,
      // APNs 5XX or transient TLS errors are retryable; 400-class
      // payload errors come back as a 'BadCollapseId' or
      // 'PayloadTooLarge' reason — those would loop forever, so mark
      // anything with a non-empty reason as non-retryable.
      retryable: failure.response?.reason === undefined,
    };
  }

  /**
   * Close the underlying HTTP/2 channel. Called once at process shutdown
   * from `apps/api/src/main.ts` (graceful drain). Safe to call multiple
   * times — the SDK's idempotent shutdown handles redundant calls.
   */
  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }

  private buildNotification(
    bundleId: string,
    rendered: RenderedPushNotification,
  ): apn.Notification {
    const notification = new apn.Notification();
    notification.topic = bundleId;
    notification.alert = { title: rendered.title, body: rendered.body };
    notification.contentAvailable = rendered.contentAvailable;
    notification.pushType = rendered.contentAvailable ? 'background' : 'alert';
    // contentAvailable: true with priority 10 is illegal per Apple (would
    // be rejected as 'BadPriority'); priority 5 is the documented setting
    // for background push, so we set it explicitly whenever silent.
    notification.priority = rendered.contentAvailable ? 5 : 10;
    if (rendered.collapseId !== undefined) {
      notification.collapseId = rendered.collapseId;
    }
    // `apn.Notification.payload` is `any` in the SDK declarations — narrow
    // through a typed reference rather than writing through `any`. The
    // SDK serializes whatever object we hand it as JSON, so a flat
    // string→string map is exactly what the iOS apps already parse out
    // of `userInfo`.
    const payloadView: { payload: Record<string, string> } = notification;
    payloadView.payload = { ...rendered.data };
    return notification;
  }
}
