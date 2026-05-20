import type { Recipient, RenderedNotification, ProviderSendResult } from '../types.js';

/**
 * Channel-scoped delivery boundary. Implementations wrap exactly one
 * SDK (`@parse/node-apn`, `twilio`, `resend`) and take care of:
 *   - SDK initialization (held at composition root, not per call)
 *   - mapping our typed `Recipient`/`RenderedNotification` to the SDK call
 *   - normalizing every failure mode into a `ProviderSendResult`
 *     (no throws — the dispatcher decides what to do with the row)
 *
 * The dispatcher never holds more than one Provider per channel, and
 * every Provider is reentrant — multiple sends in flight share the same
 * underlying SDK client.
 */
export interface NotificationProvider {
  /**
   * The channel this provider handles. The dispatcher's
   * channel→provider lookup table is built from this field so adding a
   * second SMS provider is a config change, not a code one.
   */
  readonly channel: Recipient['channel'];

  /**
   * Deliver one rendered notification. Returns a structured result; never
   * throws for transport/credentials/rejection errors. Throws only on
   * caller programming errors (e.g. passing a `RenderedEmailNotification`
   * to the SMS provider) — those are surfaced as `TypeError` so the
   * dispatcher's outer catch logs them with stack and exits without
   * retrying.
   */
  send(recipient: Recipient, rendered: RenderedNotification): Promise<ProviderSendResult>;
}
