import type { ProviderSendResult, Recipient, RenderedNotification } from '../types.js';
import type { NotificationProvider } from './provider.js';

/**
 * Narrowed view of the Resend emails API surface we depend on. The
 * upstream type is `Resend['emails']`; pulling out just `send` keeps
 * the test stub minimal and the provider robust to SDK refactors of
 * unrelated endpoints (broadcasts, contacts, ...).
 */
export interface ResendEmailsApi {
  send(payload: ResendSendPayload): Promise<ResendSendResponse>;
}

export interface ResendSendPayload {
  readonly from: string;
  readonly to: string | string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export type ResendSendResponse =
  | { readonly data: { readonly id: string }; readonly error: null }
  | { readonly data: null; readonly error: ResendErrorBody };

export interface ResendErrorBody {
  readonly message: string;
  readonly name?: string;
  readonly statusCode?: number;
}

export interface ResendProviderConfig {
  readonly emails: ResendEmailsApi;
  /** Default `From` address — overridden per-template via `fromOverride`. */
  readonly defaultFromEmail: string;
}

/**
 * Resend error names that indicate a non-retryable failure. The full
 * list is in the Resend docs under "Errors" — most failures are 4xx
 * with one of these names; transient 5xx errors come through with a
 * different name and remain retryable.
 */
const RESEND_PERMANENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'invalid_to_address',
  'invalid_from_address',
  'validation_error',
  'missing_required_field',
  'invalid_attachment',
  'restricted_api_key',
]);

export class ResendEmailProvider implements NotificationProvider {
  public readonly channel = 'email' as const;
  private readonly emails: ResendEmailsApi;
  private readonly defaultFromEmail: string;

  constructor(config: ResendProviderConfig) {
    this.emails = config.emails;
    this.defaultFromEmail = config.defaultFromEmail;
  }

  async send(recipient: Recipient, rendered: RenderedNotification): Promise<ProviderSendResult> {
    if (recipient.channel !== 'email') {
      throw new TypeError(
        `ResendEmailProvider only handles email recipients, got channel=${recipient.channel}`,
      );
    }
    if (rendered.channel !== 'email') {
      throw new TypeError(
        `ResendEmailProvider only handles email rendered payloads, got channel=${rendered.channel}`,
      );
    }

    const from = rendered.fromOverride ?? this.defaultFromEmail;

    const payload: ResendSendPayload = {
      from,
      to: recipient.emailAddress,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html !== undefined ? { html: rendered.html } : {}),
    };

    try {
      const response = await this.emails.send(payload);

      if (response.error !== null) {
        const name = response.error.name ?? '';
        return {
          ok: false,
          error: `resend rejected: ${response.error.message}${name !== '' ? ` (${name})` : ''}`,
          retryable: !RESEND_PERMANENT_ERROR_NAMES.has(name),
        };
      }

      return { ok: true, providerRef: response.data.id };
    } catch (err: unknown) {
      // Network / DNS / TLS errors land here — never permanent, the worker
      // should retry per the backoff ladder.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `resend request failed: ${message}`,
        retryable: true,
      };
    }
  }
}
