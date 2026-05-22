/**
 * ResendEmailProvider unit tests.
 *
 * Pin three contracts:
 *   1. From-address resolution — `fromOverride` on the rendered payload
 *      wins; otherwise the constructor default is used.
 *   2. HTML inclusion — `html` is included on the API payload iff the
 *      template provided one. (Critical: the `?:` field must not become
 *      `html: undefined`, or Resend will refuse the request.)
 *   3. Error classification — Resend's permanent error names map to
 *      `retryable: false`; transient names + SDK throws stay retryable.
 */
import { describe, expect, it } from 'vitest';
import {
  ResendEmailProvider,
  type ResendEmailsApi,
  type ResendSendPayload,
  type ResendSendResponse,
} from './resend.provider.js';
import type { Recipient, RenderedEmailNotification, RenderedSmsNotification } from '../types.js';

type SendOutcome =
  | { readonly kind: 'resolve'; readonly value: ResendSendResponse }
  | { readonly kind: 'throw'; readonly error: unknown };

function buildEmailsApi(outcomes: SendOutcome[]): {
  readonly api: ResendEmailsApi;
  readonly calls: ResendSendPayload[];
} {
  const calls: ResendSendPayload[] = [];
  const queue = [...outcomes];
  const api: ResendEmailsApi = {
    // Async so non-Error throws (string, etc.) get wrapped into a rejected
    // promise without tripping `prefer-promise-reject-errors`. The provider
    // must still treat them as transient — that path is what we're testing.
    send: async (payload) => {
      // Microtask boundary so the thrown value reaches the caller as
      // a rejected promise (matching real SDK behavior).
      await Promise.resolve();
      calls.push(payload);
      const next = queue.shift();
      if (next === undefined) {
        throw new TypeError('no queued resend outcome');
      }
      if (next.kind === 'throw') {
        throw next.error;
      }
      return next.value;
    },
  };
  return { api, calls };
}

function emailRecipient(): Extract<Recipient, { channel: 'email' }> {
  return { channel: 'email', userId: 'user-1', emailAddress: 'sam@example.com' };
}

function renderedEmail(
  overrides: Partial<RenderedEmailNotification> = {},
): RenderedEmailNotification {
  return {
    channel: 'email',
    subject: 'Your DankDash order #01935F3D was delivered',
    text: 'Thanks for your order!',
    ...overrides,
  };
}

function buildProvider(
  api: ResendEmailsApi,
  defaultFrom = 'orders@dankdash.com',
): ResendEmailProvider {
  return new ResendEmailProvider({ emails: api, defaultFromEmail: defaultFrom });
}

describe('ResendEmailProvider.send — success path', () => {
  it('returns provider_ref from response.data.id and uses the default from address', async () => {
    const emails = buildEmailsApi([
      { kind: 'resolve', value: { data: { id: 'res_123' }, error: null } },
    ]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({ ok: true, providerRef: 'res_123' });
    const call = emails.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.from).toBe('orders@dankdash.com');
    expect(call.to).toBe('sam@example.com');
    expect(call.subject).toBe('Your DankDash order #01935F3D was delivered');
    expect(call.text).toBe('Thanks for your order!');
    expect(call.html).toBeUndefined();
    expect('html' in call).toBe(false);
  });

  it('honors fromOverride from the rendered template', async () => {
    const emails = buildEmailsApi([
      { kind: 'resolve', value: { data: { id: 'res_456' }, error: null } },
    ]);
    const provider = buildProvider(emails.api);

    await provider.send(emailRecipient(), renderedEmail({ fromOverride: 'ops@dankdash.com' }));

    const call = emails.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.from).toBe('ops@dankdash.com');
  });

  it('includes html when the template provides it', async () => {
    const emails = buildEmailsApi([
      { kind: 'resolve', value: { data: { id: 'res_789' }, error: null } },
    ]);
    const provider = buildProvider(emails.api);

    await provider.send(emailRecipient(), renderedEmail({ html: '<p>Thanks for your order!</p>' }));

    const call = emails.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.html).toBe('<p>Thanks for your order!</p>');
  });
});

describe('ResendEmailProvider.send — API-returned error payloads', () => {
  it.each([
    ['invalid_to_address'],
    ['invalid_from_address'],
    ['validation_error'],
    ['missing_required_field'],
    ['invalid_attachment'],
    ['restricted_api_key'],
  ])('marks permanent error name "%s" as non-retryable', async (name) => {
    const emails = buildEmailsApi([
      {
        kind: 'resolve',
        value: { data: null, error: { message: 'rejected', name } },
      },
    ]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({
      ok: false,
      error: `resend rejected: rejected (${name})`,
      retryable: false,
    });
  });

  it('treats an unknown error name as retryable (likely transient 5xx)', async () => {
    const emails = buildEmailsApi([
      {
        kind: 'resolve',
        value: {
          data: null,
          error: { message: 'upstream is overloaded', name: 'internal_server_error' },
        },
      },
    ]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({
      ok: false,
      error: 'resend rejected: upstream is overloaded (internal_server_error)',
      retryable: true,
    });
  });

  it('omits the parenthesized name when error.name is absent', async () => {
    const emails = buildEmailsApi([
      {
        kind: 'resolve',
        value: { data: null, error: { message: 'no idea what went wrong' } },
      },
    ]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({
      ok: false,
      error: 'resend rejected: no idea what went wrong',
      retryable: true,
    });
  });
});

describe('ResendEmailProvider.send — SDK throws', () => {
  it('marks an Error throw as retryable (transport / DNS / TLS)', async () => {
    const err = new Error('ENOTFOUND api.resend.com');
    const emails = buildEmailsApi([{ kind: 'throw', error: err }]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({
      ok: false,
      error: 'resend request failed: ENOTFOUND api.resend.com',
      retryable: true,
    });
  });

  it('coerces non-Error throws via String() and stays retryable', async () => {
    const emails = buildEmailsApi([{ kind: 'throw', error: 'plain string blast' }]);
    const provider = buildProvider(emails.api);

    const result = await provider.send(emailRecipient(), renderedEmail());

    expect(result).toEqual({
      ok: false,
      error: 'resend request failed: plain string blast',
      retryable: true,
    });
  });
});

describe('ResendEmailProvider.send — guard clauses', () => {
  it('throws TypeError when the recipient is the wrong channel', async () => {
    const emails = buildEmailsApi([]);
    const provider = buildProvider(emails.api);
    const wrong: Recipient = {
      channel: 'sms',
      userId: 'u',
      phoneE164: '+15551112222',
    };

    await expect(provider.send(wrong, renderedEmail())).rejects.toThrow(
      'ResendEmailProvider only handles email recipients, got channel=sms',
    );
  });

  it('throws TypeError when the rendered payload is the wrong channel', async () => {
    const emails = buildEmailsApi([]);
    const provider = buildProvider(emails.api);
    const wrong: RenderedSmsNotification = { channel: 'sms', body: 'b' };

    await expect(provider.send(emailRecipient(), wrong)).rejects.toThrow(
      'ResendEmailProvider only handles email rendered payloads, got channel=sms',
    );
  });
});

describe('ResendEmailProvider.channel', () => {
  it('reports channel = "email" so the dispatcher routes email recipients here', () => {
    const emails = buildEmailsApi([]);
    const provider = buildProvider(emails.api);
    expect(provider.channel).toBe('email');
  });
});
