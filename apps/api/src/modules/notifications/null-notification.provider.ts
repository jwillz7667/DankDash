/**
 * NotificationProvider that records every send as a non-retryable skip.
 * Wired by NotificationsModule when `ENABLE_TWILIO` / `ENABLE_RESEND` is
 * false — the dispatcher still flows orders through its dedupe + ledger
 * path, but the actual transport is suppressed and the failure reason
 * lands on the persisted row so ops can audit what wasn't sent.
 *
 * Returns `retryable: false` so BullMQ doesn't re-enqueue the job; the
 * provider is gated by the deployment, not the network.
 */
import type { NotificationProvider, ProviderSendResult, Recipient } from '@dankdash/notifications';

export class NullNotificationProvider implements NotificationProvider {
  constructor(
    public readonly channel: Recipient['channel'],
    private readonly featureName: string,
  ) {}

  send(): Promise<ProviderSendResult> {
    return Promise.resolve({
      ok: false,
      error: `${this.featureName}_DISABLED`,
      retryable: false,
    });
  }
}
