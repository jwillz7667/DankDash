/**
 * TwilioSmsProvider unit tests.
 *
 * Pin three contracts:
 *   1. Sender wiring — `messagingServiceSid` takes precedence over
 *      `fromNumber`, exactly one ends up on the create() call, and
 *      constructing with neither throws immediately.
 *   2. Error classification — Twilio's permanent error codes (21610
 *      unsubscribed, 30007 spam, etc.) map to `retryable: false`. Anything
 *      else, including SDK throws without a code, stays retryable.
 *   3. Channel discipline — wrong-channel recipient/rendered payloads
 *      throw TypeError instead of returning a failure (caller bug).
 */
import { describe, expect, it } from 'vitest';
import {
  TwilioSmsProvider,
  type TwilioMessageCreateParams,
  type TwilioMessageInstance,
  type TwilioMessagesApi,
} from './twilio.provider.js';
import type { Recipient, RenderedPushNotification, RenderedSmsNotification } from '../types.js';

type CreateOutcome =
  | { readonly kind: 'resolve'; readonly value: TwilioMessageInstance }
  | { readonly kind: 'throw'; readonly error: unknown };

function buildMessagesApi(outcomes: CreateOutcome[]): {
  readonly api: TwilioMessagesApi;
  readonly calls: TwilioMessageCreateParams[];
} {
  const calls: TwilioMessageCreateParams[] = [];
  const queue = [...outcomes];
  const api: TwilioMessagesApi = {
    // Async so the thrown value is wrapped into a rejected promise the
    // same way the Twilio SDK throws — and so non-Error rejects don't
    // trip `prefer-promise-reject-errors`.
    create: async (params) => {
      // Microtask boundary so the thrown value reaches the caller as
      // a rejected promise (matching real SDK behavior).
      await Promise.resolve();
      calls.push(params);
      const next = queue.shift();
      if (next === undefined) {
        throw new TypeError('no queued twilio outcome');
      }
      if (next.kind === 'throw') {
        throw next.error;
      }
      return next.value;
    },
  };
  return { api, calls };
}

function smsRecipient(): Extract<Recipient, { channel: 'sms' }> {
  return { channel: 'sms', userId: 'user-1', phoneE164: '+15551234567' };
}

function renderedSms(body = 'Your order is on the way.'): RenderedSmsNotification {
  return { channel: 'sms', body };
}

function successMessage(sid = 'SMxxxx'): TwilioMessageInstance {
  return { sid, errorCode: null, errorMessage: null, status: 'queued' };
}

describe('TwilioSmsProvider constructor', () => {
  it('throws TypeError when neither messagingServiceSid nor fromNumber is configured', () => {
    const messages = buildMessagesApi([]);
    expect(() => new TwilioSmsProvider({ messages: messages.api })).toThrow(TypeError);
  });

  it('treats an empty-string messagingServiceSid as unconfigured (falls through to fromNumber)', async () => {
    const messages = buildMessagesApi([{ kind: 'resolve', value: successMessage() }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: '',
      fromNumber: '+15550000000',
    });

    await provider.send(smsRecipient(), renderedSms());

    const call = messages.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.from).toBe('+15550000000');
    expect(call.messagingServiceSid).toBeUndefined();
  });

  it('throws TypeError when both messagingServiceSid and fromNumber are empty strings', () => {
    const messages = buildMessagesApi([]);
    expect(
      () =>
        new TwilioSmsProvider({
          messages: messages.api,
          messagingServiceSid: '',
          fromNumber: '',
        }),
    ).toThrow(TypeError);
  });
});

describe('TwilioSmsProvider.send — sender selection', () => {
  it('uses messagingServiceSid when both it and fromNumber are configured', async () => {
    const messages = buildMessagesApi([{ kind: 'resolve', value: successMessage('SM-mss') }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxxxxxxxxxxxxxxx',
      fromNumber: '+15550000000',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({ ok: true, providerRef: 'SM-mss' });
    const call = messages.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.messagingServiceSid).toBe('MGxxxxxxxxxxxxxxxx');
    expect(call.from).toBeUndefined();
    expect(call.to).toBe('+15551234567');
    expect(call.body).toBe('Your order is on the way.');
  });

  it('uses fromNumber when messagingServiceSid is absent', async () => {
    const messages = buildMessagesApi([{ kind: 'resolve', value: successMessage('SM-from') }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      fromNumber: '+15550000000',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({ ok: true, providerRef: 'SM-from' });
    const call = messages.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.from).toBe('+15550000000');
    expect(call.messagingServiceSid).toBeUndefined();
  });
});

describe('TwilioSmsProvider.send — API-returned error codes', () => {
  it.each([
    [21211, 'invalid To'],
    [21610, 'unsubscribed'],
    [21614, 'not mobile'],
    [21408, 'no permission'],
    [30003, 'unreachable'],
    [30005, 'unknown destination'],
    [30006, 'landline'],
    [30007, 'spam'],
  ])('marks permanent error code %i as non-retryable', async (errorCode, errorMessage) => {
    const messages = buildMessagesApi([
      {
        kind: 'resolve',
        value: { sid: 'SMxxx', errorCode, errorMessage, status: 'failed' },
      },
    ]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: `twilio rejected: ${errorMessage} (code=${errorCode})`,
      retryable: false,
    });
  });

  it('treats an unknown error code as retryable (transient)', async () => {
    const messages = buildMessagesApi([
      {
        kind: 'resolve',
        value: {
          sid: 'SMxxx',
          errorCode: 30500,
          errorMessage: 'queued for retry',
          status: 'failed',
        },
      },
    ]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: 'twilio rejected: queued for retry (code=30500)',
      retryable: true,
    });
  });

  it('substitutes "unknown" when errorMessage is null', async () => {
    const messages = buildMessagesApi([
      {
        kind: 'resolve',
        value: { sid: 'SMxxx', errorCode: 30500, errorMessage: null, status: 'failed' },
      },
    ]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: 'twilio rejected: unknown (code=30500)',
      retryable: true,
    });
  });
});

describe('TwilioSmsProvider.send — SDK throws', () => {
  it('marks an SDK throw with a permanent code (30007 spam) as non-retryable', async () => {
    const err = Object.assign(new Error('blocked as spam'), { code: 30007, status: 400 });
    const messages = buildMessagesApi([{ kind: 'throw', error: err }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: 'twilio request failed: blocked as spam (code=30007)',
      retryable: false,
    });
  });

  it('marks an SDK throw with a non-permanent code as retryable', async () => {
    const err = Object.assign(new Error('queue full'), { code: 20429 });
    const messages = buildMessagesApi([{ kind: 'throw', error: err }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: 'twilio request failed: queue full (code=20429)',
      retryable: true,
    });
  });

  it('marks an SDK throw without a numeric code as retryable (transport-level)', async () => {
    const err = new Error('ECONNRESET');
    const messages = buildMessagesApi([{ kind: 'throw', error: err }]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });

    const result = await provider.send(smsRecipient(), renderedSms());

    expect(result).toEqual({
      ok: false,
      error: 'twilio request failed: ECONNRESET',
      retryable: true,
    });
  });
});

describe('TwilioSmsProvider.send — guard clauses', () => {
  it('throws TypeError when the recipient is the wrong channel', async () => {
    const messages = buildMessagesApi([]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });
    const wrong: Recipient = {
      channel: 'email',
      userId: 'u',
      emailAddress: 'a@b.co',
    };

    await expect(provider.send(wrong, renderedSms())).rejects.toThrow(
      'TwilioSmsProvider only handles sms recipients, got channel=email',
    );
  });

  it('throws TypeError when the rendered payload is the wrong channel', async () => {
    const messages = buildMessagesApi([]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });
    const wrong: RenderedPushNotification = {
      channel: 'push',
      title: 't',
      body: 'b',
      data: {},
      contentAvailable: false,
    };

    await expect(provider.send(smsRecipient(), wrong)).rejects.toThrow(
      'TwilioSmsProvider only handles sms rendered payloads, got channel=push',
    );
  });
});

describe('TwilioSmsProvider.channel', () => {
  it('reports channel = "sms" so the dispatcher routes sms recipients here', () => {
    const messages = buildMessagesApi([]);
    const provider = new TwilioSmsProvider({
      messages: messages.api,
      messagingServiceSid: 'MGxxx',
    });
    expect(provider.channel).toBe('sms');
  });
});
