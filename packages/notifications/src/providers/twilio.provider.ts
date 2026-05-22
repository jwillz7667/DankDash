import type { ProviderSendResult, Recipient, RenderedNotification } from '../types.js';
import type { NotificationProvider } from './provider.js';

/**
 * Narrowed view of the Twilio messages API surface — we use create()
 * only, and the return type's `sid` and `errorCode`/`errorMessage` fields.
 * Wrapping it in a tiny interface keeps the constructor signature
 * stable across Twilio SDK majors and gives tests a tight stub target.
 */
export interface TwilioMessagesApi {
  create(params: TwilioMessageCreateParams): Promise<TwilioMessageInstance>;
}

export interface TwilioMessageCreateParams {
  readonly to: string;
  readonly body: string;
  readonly from?: string;
  readonly messagingServiceSid?: string;
}

export interface TwilioMessageInstance {
  readonly sid: string;
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface TwilioSmsProviderConfig {
  readonly messages: TwilioMessagesApi;
  /**
   * One of these two MUST be set. The provider construction throws if
   * neither is configured — Twilio rejects the message synchronously
   * otherwise, but failing fast at boot is friendlier than at 03:00.
   */
  readonly messagingServiceSid?: string;
  readonly fromNumber?: string;
}

/**
 * Twilio API error shape — wrapping `Error` so we can read the
 * upstream-assigned numeric code without an `any` cast. Real errors
 * thrown by the SDK match this layout; SDK-internal failures (network
 * timeout, DNS) come through as a plain `Error`.
 */
interface TwilioRestError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly moreInfo?: string;
}

/**
 * Twilio error codes that are not transient — re-sending will produce
 * the same outcome. We mark these `retryable: false` so the worker
 * stops retrying immediately. Source:
 *   - 21211 invalid 'To' phone number
 *   - 21610 phone number unsubscribed (STOP keyword)
 *   - 21614 number not a mobile / cannot receive SMS
 *   - 21408 permission to send to that country missing
 *   - 30003 unreachable handset
 *   - 30005 unknown destination
 *   - 30006 landline / unreachable carrier
 *   - 30007 carrier rejected as spam
 */
const TWILIO_PERMANENT_ERROR_CODES: ReadonlySet<number> = new Set([
  21211, 21610, 21614, 21408, 30003, 30005, 30006, 30007,
]);

/**
 * Discriminated sender — exactly one of `{messagingServiceSid}` or
 * `{from}` is set after construction, which means the per-call params
 * spread cleanly into `MessageListInstanceCreateOptions` without TS
 * widening the field to `string | undefined`.
 */
type TwilioSender = { readonly messagingServiceSid: string } | { readonly from: string };

export class TwilioSmsProvider implements NotificationProvider {
  public readonly channel = 'sms' as const;
  private readonly messages: TwilioMessagesApi;
  private readonly sender: TwilioSender;

  constructor(config: TwilioSmsProviderConfig) {
    if (config.messagingServiceSid !== undefined && config.messagingServiceSid !== '') {
      this.sender = { messagingServiceSid: config.messagingServiceSid };
    } else if (config.fromNumber !== undefined && config.fromNumber !== '') {
      this.sender = { from: config.fromNumber };
    } else {
      throw new TypeError(
        'TwilioSmsProvider requires messagingServiceSid or fromNumber to be configured',
      );
    }
    this.messages = config.messages;
  }

  async send(recipient: Recipient, rendered: RenderedNotification): Promise<ProviderSendResult> {
    if (recipient.channel !== 'sms') {
      throw new TypeError(
        `TwilioSmsProvider only handles sms recipients, got channel=${recipient.channel}`,
      );
    }
    if (rendered.channel !== 'sms') {
      throw new TypeError(
        `TwilioSmsProvider only handles sms rendered payloads, got channel=${rendered.channel}`,
      );
    }

    const params: TwilioMessageCreateParams = {
      to: recipient.phoneE164,
      body: rendered.body,
      ...this.sender,
    };

    try {
      const message = await this.messages.create(params);

      if (message.errorCode !== null) {
        return {
          ok: false,
          error: `twilio rejected: ${message.errorMessage ?? 'unknown'} (code=${message.errorCode})`,
          retryable: !TWILIO_PERMANENT_ERROR_CODES.has(message.errorCode),
        };
      }

      return { ok: true, providerRef: message.sid };
    } catch (err: unknown) {
      const error = err as TwilioRestError;
      const code = typeof error.code === 'number' ? error.code : undefined;
      return {
        ok: false,
        error: `twilio request failed: ${error.message}${code !== undefined ? ` (code=${code})` : ''}`,
        retryable: code === undefined || !TWILIO_PERMANENT_ERROR_CODES.has(code),
      };
    }
  }
}
