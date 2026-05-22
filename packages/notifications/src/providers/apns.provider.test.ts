/**
 * ApnsProvider unit tests.
 *
 * The provider wraps `@parse/node-apn` and is the only place push tokens
 * actually leave the process. The contract we pin here:
 *   - successful sends return the device token echo for `provider_ref`
 *   - APNs "dead token" reasons (BadDeviceToken / Unregistered /
 *     DeviceTokenNotForTopic) surface `retireApnsToken` so the dispatcher
 *     deactivates the token row in `push_tokens`
 *   - non-dead 4xx reasons stay non-retryable to avoid replay loops
 *   - missing reason / transient transport failures stay retryable
 *   - wrong-channel inputs throw TypeError (caller programming error)
 *
 * We stub `apn.Provider` through the `provider` config field so we never
 * actually open an HTTP/2 socket; the SDK's Notification class is real
 * because its mutations are trivial setters.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApnsProvider, type ApnsProviderHandle } from './apns.provider.js';
import type { Recipient, RenderedEmailNotification, RenderedPushNotification } from '../types.js';
import type apn from '@parse/node-apn';

type ApnsResponses = apn.Responses<apn.ResponseSent, apn.ResponseFailure>;

function buildStub(responses: ApnsResponses[]): {
  readonly handle: ApnsProviderHandle;
  readonly calls: Array<{
    readonly notification: apn.Notification;
    readonly recipients: string | string[];
  }>;
  readonly shutdown: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{
    readonly notification: apn.Notification;
    readonly recipients: string | string[];
  }> = [];
  const queue = [...responses];
  const shutdown = vi.fn((): Promise<void> => Promise.resolve());
  const handle: ApnsProviderHandle = {
    send: (notification, recipients) => {
      calls.push({ notification, recipients });
      const next = queue.shift();
      if (next === undefined) {
        throw new TypeError('no queued apns response');
      }
      return Promise.resolve(next);
    },
    shutdown,
  };
  return { handle, calls, shutdown };
}

function pushRecipient(
  apnsTokens: ReadonlyArray<string> = ['device-token-aaaa'],
): Extract<Recipient, { channel: 'push' }> {
  return {
    channel: 'push',
    userId: 'user-1',
    apnsTokens,
    bundleId: 'com.dankdash.consumer',
  };
}

function renderedPush(overrides: Partial<RenderedPushNotification> = {}): RenderedPushNotification {
  return {
    channel: 'push',
    title: 'Order accepted',
    body: 'Green Roots accepted your order #01935F3D.',
    data: { orderId: '01935f3d', templateKey: 'order.accepted' },
    contentAvailable: false,
    ...overrides,
  };
}

function buildProvider(handle: ApnsProviderHandle): ApnsProvider {
  return new ApnsProvider({
    keyId: 'KEYID12345',
    teamId: 'TEAMID6789',
    privateKey: 'PEM',
    production: false,
    provider: handle,
  });
}

/**
 * Read the SDK's internal `aps` bag — `alert` / `contentAvailable` /
 * `mutableContent` are write-only setters on `apn.Notification`, so the
 * only way to verify what we sent is to inspect `aps` directly. The cast
 * is narrowed to the keys we touch.
 */
function readAps(notification: apn.Notification): {
  readonly alert?: { readonly title: string; readonly body: string } | string;
  readonly 'content-available'?: number;
} {
  const view = notification as unknown as {
    aps: {
      readonly alert?: { readonly title: string; readonly body: string } | string;
      readonly 'content-available'?: number;
    };
  };
  return view.aps;
}

describe('ApnsProvider.send — success path', () => {
  it('returns provider_ref echoing the device token from sent[0]', async () => {
    const sent: apn.ResponseSent = { device: 'device-token-aaaa' };
    const stub = buildStub([{ sent: [sent], failed: [] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({ ok: true, providerRef: 'device-token-aaaa' });
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.recipients).toEqual(['device-token-aaaa']);
    expect(call.notification.topic).toBe('com.dankdash.consumer');
    // `alert` and `contentAvailable` are write-only setters on the
    // node-apn Notification — the values land on `aps` directly.
    expect(readAps(call.notification)['alert']).toEqual({
      title: 'Order accepted',
      body: 'Green Roots accepted your order #01935F3D.',
    });
    expect(call.notification.priority).toBe(10);
    expect(call.notification.pushType).toBe('alert');
  });

  it('falls back to bundleId when sent[0].device is undefined (older mock shape)', async () => {
    const sent = { device: undefined } as unknown as apn.ResponseSent;
    const stub = buildStub([{ sent: [sent], failed: [] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({ ok: true, providerRef: 'com.dankdash.consumer' });
  });

  it('configures silent/background push when contentAvailable=true (pushType=background, priority=5)', async () => {
    const stub = buildStub([{ sent: [{ device: 'device-token-aaaa' }], failed: [] }]);
    const provider = buildProvider(stub.handle);

    await provider.send(pushRecipient(), renderedPush({ contentAvailable: true, body: 'silent' }));

    const call = stub.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.notification.pushType).toBe('background');
    expect(call.notification.priority).toBe(5);
    expect(readAps(call.notification)['content-available']).toBe(1);
  });

  it('sets collapseId on the SDK notification when the template provides one', async () => {
    const stub = buildStub([{ sent: [{ device: 'device-token-aaaa' }], failed: [] }]);
    const provider = buildProvider(stub.handle);

    await provider.send(pushRecipient(), renderedPush({ collapseId: 'order-01935f3d' }));

    const call = stub.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    expect(call.notification.collapseId).toBe('order-01935f3d');
  });

  it('serializes rendered.data into the SDK payload as a flat string map', async () => {
    const stub = buildStub([{ sent: [{ device: 'device-token-aaaa' }], failed: [] }]);
    const provider = buildProvider(stub.handle);

    await provider.send(
      pushRecipient(),
      renderedPush({ data: { orderId: 'o1', templateKey: 'order.accepted' } }),
    );

    const call = stub.calls[0];
    if (call === undefined) throw new TypeError('expected one call');
    const payloadView = call.notification as unknown as {
      payload: Record<string, string>;
    };
    expect(payloadView.payload).toEqual({
      orderId: 'o1',
      templateKey: 'order.accepted',
    });
  });
});

describe('ApnsProvider.send — dead-token retirement', () => {
  it.each([['BadDeviceToken'], ['Unregistered'], ['DeviceTokenNotForTopic']])(
    'treats %s as a dead token and emits retireApnsToken',
    async (reason) => {
      const failed: apn.ResponseFailure = {
        device: 'device-token-aaaa',
        status: 410,
        response: { reason },
      };
      const stub = buildStub([{ sent: [], failed: [failed] }]);
      const provider = buildProvider(stub.handle);

      const result = await provider.send(pushRecipient(), renderedPush());

      expect(result).toEqual({
        ok: false,
        error: `apns rejected token: ${reason}`,
        retryable: false,
        retireApnsToken: 'device-token-aaaa',
      });
    },
  );
});

describe('ApnsProvider.send — non-dead failures', () => {
  it('marks a 4xx-class reason (e.g. PayloadTooLarge) non-retryable without retiring the token', async () => {
    const failed: apn.ResponseFailure = {
      device: 'device-token-aaaa',
      status: 400,
      response: { reason: 'PayloadTooLarge' },
    };
    const stub = buildStub([{ sent: [], failed: [failed] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({
      ok: false,
      error: 'apns failure: PayloadTooLarge',
      retryable: false,
    });
    if (result.ok) throw new TypeError('expected failure');
    expect(result.retireApnsToken).toBeUndefined();
  });

  it('treats a failure without a response.reason as retryable (transient transport/5xx)', async () => {
    const failed: apn.ResponseFailure = {
      device: 'device-token-aaaa',
      error: new Error('socket hang up'),
    };
    const stub = buildStub([{ sent: [], failed: [failed] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({
      ok: false,
      error: 'apns failure: socket hang up',
      retryable: true,
    });
  });

  it('falls back to "unknown apns failure" when neither reason nor error.message is present', async () => {
    const failed: apn.ResponseFailure = {
      device: 'device-token-aaaa',
    };
    const stub = buildStub([{ sent: [], failed: [failed] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({
      ok: false,
      error: 'apns failure: unknown apns failure',
      retryable: true,
    });
  });

  it('returns "apns returned no result" (retryable) when sent and failed are both empty', async () => {
    const stub = buildStub([{ sent: [], failed: [] }]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient(), renderedPush());

    expect(result).toEqual({
      ok: false,
      error: 'apns returned no result',
      retryable: true,
    });
  });
});

describe('ApnsProvider.send — guard clauses', () => {
  it('returns a non-retryable "no apns tokens" failure when the token list is empty', async () => {
    const stub = buildStub([]);
    const provider = buildProvider(stub.handle);

    const result = await provider.send(pushRecipient([]), renderedPush());

    expect(result).toEqual({
      ok: false,
      error: 'no apns tokens for recipient',
      retryable: false,
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('throws TypeError when the recipient is the wrong channel', async () => {
    const stub = buildStub([]);
    const provider = buildProvider(stub.handle);
    const wrongRecipient = {
      channel: 'sms',
      userId: 'u',
      phoneE164: '+15551112222',
    } as const satisfies Recipient;

    await expect(provider.send(wrongRecipient, renderedPush())).rejects.toThrow(
      'ApnsProvider only handles push recipients, got channel=sms',
    );
  });

  it('throws TypeError when the rendered payload is the wrong channel', async () => {
    const stub = buildStub([]);
    const provider = buildProvider(stub.handle);
    const wrongRendered: RenderedEmailNotification = {
      channel: 'email',
      subject: 's',
      text: 't',
    };

    await expect(provider.send(pushRecipient(), wrongRendered)).rejects.toThrow(
      'ApnsProvider only handles push rendered payloads, got channel=email',
    );
  });
});

describe('ApnsProvider.shutdown', () => {
  it('proxies through to the underlying provider handle', async () => {
    const stub = buildStub([]);
    const provider = buildProvider(stub.handle);

    await provider.shutdown();

    expect(stub.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('ApnsProvider constructor', () => {
  it('uses the provided handle when one is supplied (no real apn.Provider opened)', () => {
    const stub = buildStub([]);
    const provider = buildProvider(stub.handle);
    expect(provider.channel).toBe('push');
  });

  it('falls back to a real apn.Provider when no override is supplied', async () => {
    // We mock the SDK so the real constructor branch (`new apn.Provider`)
    // executes without opening an HTTP/2 socket to Apple. The mock is
    // scoped to this test via isolated import + restore so other tests
    // continue to use the real `apn` module shape.
    const constructorCalls: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock('@parse/node-apn', () => ({
      default: {
        Provider: class {
          constructor(opts: Record<string, unknown>) {
            constructorCalls.push(opts);
          }
          send = (): Promise<unknown> => Promise.resolve({ sent: [], failed: [] });
          shutdown = (): Promise<void> => Promise.resolve();
        },
      },
    }));
    try {
      const { ApnsProvider: FreshApnsProvider } = await import('./apns.provider.js');
      const provider = new FreshApnsProvider({
        keyId: 'KEYID',
        teamId: 'TEAMID',
        privateKey: 'PEM',
        production: true,
      });
      expect(provider.channel).toBe('push');
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0]).toEqual({
        token: { key: 'PEM', keyId: 'KEYID', teamId: 'TEAMID' },
        production: true,
      });
    } finally {
      vi.doUnmock('@parse/node-apn');
      vi.resetModules();
    }
  });
});
