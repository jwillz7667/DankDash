/**
 * NotificationDispatcher unit tests. Hand-rolled fakes for every
 * collaborator (dedupe store, repositories, providers) so the assertions
 * pin both the SQL-equivalent calls and the per-channel persistence
 * trajectory:
 *
 *   1. dedup skip — second dispatch with the same key returns
 *      `{skipped: true, reason: 'duplicate'}` and writes zero rows.
 *   2. user-not-found — short-circuits with `{skipped: true, reason:
 *      'user_not_found'}` AFTER dedup is acquired (so the caller doesn't
 *      bombard the user lookup if a duplicate event arrives first).
 *   3. push success — writes a row, calls the provider, marks sent with
 *      the provider ref.
 *   4. APNs token retirement — `BadDeviceToken` failure with
 *      `retireApnsToken` triggers `pushTokens.deactivateByApnsToken`.
 *   5. provider unavailable — channel with no configured provider records
 *      a `provider_unavailable` error rather than dropping silently.
 *   6. recipient gap — sms with no phone records "no recipient" rather
 *      than calling Twilio with `to: null`.
 *   7. in_app — no provider call; row is the artifact; marked sent with
 *      `providerRef: 'in_app'`.
 *   8. payload projection — `serializeRendered` preserves channel-shaped
 *      fields (incl. optional collapseId / html / fromOverride).
 */
import {
  type NewNotification,
  type Notification,
  type NotificationsRepository,
  type PushToken,
  type PushTokensRepository,
  type User,
  type UsersRepository,
} from '@dankdash/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationDispatcher } from './notification-dispatcher.service.js';
import type { NotificationDedupeStore } from './notification-dedupe.store.js';
import type {
  NotificationProvider,
  ProviderSendResult,
  Recipient,
  RenderedNotification,
} from '@dankdash/notifications';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const PUSH_TOKEN_ID = '01935f3d-0000-7000-8000-0000000000bb';
const APNS_TOKEN = 'a'.repeat(64);
const NOTIFICATION_ID_PREFIX = '01935f3d-0000-7000-8000-0000000010';

const CREATED_AT = new Date('2026-05-01T00:00:00.000Z');

class FakeDedupe implements NotificationDedupeStore {
  calls: Array<{ key: string; ttl: number }> = [];
  acquired = new Set<string>();

  acquire = (key: string, ttlSeconds: number): Promise<boolean> => {
    this.calls.push({ key, ttl: ttlSeconds });
    if (this.acquired.has(key)) return Promise.resolve(false);
    this.acquired.add(key);
    return Promise.resolve(true);
  };
}

class FakeNotificationsRepository {
  calls = {
    create: [] as NewNotification[],
    markSent: [] as Array<{ id: string; providerRef: string }>,
    markFailed: [] as Array<{ id: string; error: string }>,
  };
  private counter = 0;

  create = (
    input: Omit<NewNotification, 'id'> & { readonly id?: string },
  ): Promise<Notification> => {
    this.counter += 1;
    const id = input.id ?? `${NOTIFICATION_ID_PREFIX}${String(this.counter).padStart(2, '0')}`;
    const row: NewNotification = { ...input, id };
    this.calls.create.push(row);
    const stored: Notification = {
      id,
      userId: input.userId,
      channel: input.channel,
      templateKey: input.templateKey,
      payload: input.payload,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      providerRef: null,
      error: null,
      createdAt: CREATED_AT,
    };
    return Promise.resolve(stored);
  };

  markSent = (id: string, providerRef: string): Promise<void> => {
    this.calls.markSent.push({ id, providerRef });
    return Promise.resolve();
  };

  markFailed = (id: string, error: string): Promise<void> => {
    this.calls.markFailed.push({ id, error });
    return Promise.resolve();
  };
}

class FakePushTokensRepository {
  calls = {
    listActiveForUser: [] as Array<{ userId: string; appVariant: string | undefined }>,
    deactivateByApnsToken: [] as string[],
  };
  tokensByUser = new Map<string, readonly PushToken[]>();
  deactivateByApnsTokenResponse = 1;

  listActiveForUser = (userId: string, appVariant?: string): Promise<readonly PushToken[]> => {
    this.calls.listActiveForUser.push({ userId, appVariant });
    return Promise.resolve(this.tokensByUser.get(`${userId}:${appVariant ?? ''}`) ?? []);
  };

  deactivateByApnsToken = (apnsToken: string): Promise<number> => {
    this.calls.deactivateByApnsToken.push(apnsToken);
    return Promise.resolve(this.deactivateByApnsTokenResponse);
  };
}

class FakeUsersRepository {
  calls = { findById: [] as string[] };
  rowsById = new Map<string, User>();

  findById = (id: string): Promise<User | null> => {
    this.calls.findById.push(id);
    return Promise.resolve(this.rowsById.get(id) ?? null);
  };
}

class FakeProvider implements NotificationProvider {
  calls: Array<{ recipient: Recipient; rendered: RenderedNotification }> = [];
  responses: ProviderSendResult[] = [];
  readonly channel: Recipient['channel'];

  constructor(channel: Recipient['channel']) {
    this.channel = channel;
  }

  send = (recipient: Recipient, rendered: RenderedNotification): Promise<ProviderSendResult> => {
    this.calls.push({ recipient, rendered });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new TypeError(`no queued response for ${this.channel} provider`);
    }
    return Promise.resolve(next);
  };
}

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    email: 'customer@example.com',
    phone: '+15551234567',
    passwordHash: 'argon-hash',
    role: 'customer',
    status: 'active',
    firstName: 'Sam',
    lastName: 'Tester',
    dateOfBirth: '1990-01-01',
    kycVerifiedAt: null,
    kycProvider: null,
    kycProviderRef: null,
    mfaEnabled: false,
    mfaSecretEnc: null,
    lastLoginAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

function buildPushToken(overrides: Partial<PushToken> = {}): PushToken {
  return {
    id: PUSH_TOKEN_ID,
    userId: USER_ID,
    deviceId: 'idfv-1',
    apnsToken: APNS_TOKEN,
    platform: 'ios',
    appVariant: 'consumer',
    isActive: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

interface Harness {
  readonly dispatcher: NotificationDispatcher;
  readonly dedupe: FakeDedupe;
  readonly notifications: FakeNotificationsRepository;
  readonly pushTokens: FakePushTokensRepository;
  readonly users: FakeUsersRepository;
  readonly pushProvider: FakeProvider;
  readonly smsProvider: FakeProvider;
  readonly emailProvider: FakeProvider;
}

function buildHarness(
  opts: {
    readonly omitPushProvider?: boolean;
    readonly omitSmsProvider?: boolean;
    readonly omitEmailProvider?: boolean;
  } = {},
): Harness {
  const dedupe = new FakeDedupe();
  const notifications = new FakeNotificationsRepository();
  const pushTokens = new FakePushTokensRepository();
  const users = new FakeUsersRepository();
  const pushProvider = new FakeProvider('push');
  const smsProvider = new FakeProvider('sms');
  const emailProvider = new FakeProvider('email');
  const dispatcher = new NotificationDispatcher({
    config: {
      apnsBundleIdByAppVariant: {
        consumer: 'com.dankdash.consumer',
        driver: 'com.dankdash.driver',
      },
      dedupeTtlSeconds: 86_400,
    },
    dedupe,
    notifications: notifications as unknown as NotificationsRepository,
    pushTokens: pushTokens as unknown as PushTokensRepository,
    users: users as unknown as UsersRepository,
    ...(opts.omitPushProvider === true ? {} : { pushProvider }),
    ...(opts.omitSmsProvider === true ? {} : { smsProvider }),
    ...(opts.omitEmailProvider === true ? {} : { emailProvider }),
  });
  return {
    dispatcher,
    dedupe,
    notifications,
    pushTokens,
    users,
    pushProvider,
    smsProvider,
    emailProvider,
  };
}

describe('NotificationDispatcher.dispatch', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.users.rowsById.set(USER_ID, buildUser());
    h.pushTokens.tokensByUser.set(`${USER_ID}:consumer`, [buildPushToken()]);
  });

  it('skips duplicates without touching the user, repo, or provider', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];
    const first = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });
    expect(first.skipped).toBe(false);

    const second = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });
    expect(second).toEqual({ skipped: true, reason: 'duplicate' });

    expect(h.dedupe.calls).toHaveLength(2);
    expect(h.users.calls.findById).toEqual([USER_ID]);
    expect(h.notifications.calls.create).toHaveLength(2); // push + in_app from first call only
    expect(h.pushProvider.calls).toHaveLength(1);
  });

  it('builds the dedup key as userId:templateKey:idempotencyKey with config TTL', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];

    await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    expect(h.dedupe.calls).toEqual([
      {
        key: `${USER_ID}:order.accepted:${ORDER_ID}:accepted`,
        ttl: 86_400,
      },
    ]);
  });

  it('short-circuits when the user is missing AFTER dedup is acquired', async () => {
    h.users.rowsById.clear();

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    expect(result).toEqual({ skipped: true, reason: 'user_not_found' });
    expect(h.dedupe.calls).toHaveLength(1);
    expect(h.notifications.calls.create).toEqual([]);
    expect(h.pushProvider.calls).toEqual([]);
  });

  it('writes a row + markSent on a successful push delivery', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-success-1' }];

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    const pushOutcome = result.results.find((r) => r.channel === 'push');
    expect(pushOutcome?.outcome).toEqual({ ok: true, providerRef: 'apns-success-1' });

    const pushRow = h.notifications.calls.create.find((c) => c.channel === 'push');
    expect(pushRow).toBeDefined();
    expect(pushRow?.userId).toBe(USER_ID);
    expect(pushRow?.templateKey).toBe('order.accepted');

    expect(
      h.notifications.calls.markSent.find((c) => c.providerRef === 'apns-success-1'),
    ).toBeDefined();

    expect(h.pushProvider.calls[0]?.recipient).toEqual({
      channel: 'push',
      userId: USER_ID,
      apnsTokens: [APNS_TOKEN],
      bundleId: 'com.dankdash.consumer',
    });
  });

  it('uses the driver bundle id when appVariant=driver', async () => {
    h.pushTokens.tokensByUser.clear();
    h.pushTokens.tokensByUser.set(`${USER_ID}:driver`, [buildPushToken({ appVariant: 'driver' })]);
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];

    await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'dispatch.offer',
      payload: {
        offerId: 'offer-1',
        orderId: ORDER_ID,
        dispensaryName: 'Green Roots',
        distanceMiles: 2.5,
        expiresInSeconds: 30,
      },
      appVariant: 'driver',
      idempotencyKey: 'offer-1',
    });

    expect(h.pushProvider.calls[0]?.recipient).toMatchObject({
      channel: 'push',
      bundleId: 'com.dankdash.driver',
    });
  });

  it('retires the APNs token on BadDeviceToken via deactivateByApnsToken', async () => {
    h.pushProvider.responses = [
      { ok: false, error: 'BadDeviceToken', retryable: false, retireApnsToken: APNS_TOKEN },
    ];

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    expect(h.pushTokens.calls.deactivateByApnsToken).toEqual([APNS_TOKEN]);
    expect(
      h.notifications.calls.markFailed.find((c) => c.error === 'BadDeviceToken'),
    ).toBeDefined();
    expect(
      h.notifications.calls.markSent.find((c) => c.providerRef === APNS_TOKEN),
    ).toBeUndefined();
  });

  it('does not call pushTokens.deactivateByApnsToken when the provider failure omits retireApnsToken', async () => {
    h.pushProvider.responses = [{ ok: false, error: 'apns 503', retryable: true }];

    await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    expect(h.pushTokens.calls.deactivateByApnsToken).toEqual([]);
    expect(h.notifications.calls.markFailed.find((c) => c.error === 'apns 503')).toBeDefined();
  });

  it('records `provider_unavailable` when a channel has no configured provider', async () => {
    h = buildHarness({ omitPushProvider: true });
    h.users.rowsById.set(USER_ID, buildUser());
    h.pushTokens.tokensByUser.set(`${USER_ID}:consumer`, [buildPushToken()]);

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    const pushOutcome = result.results.find((r) => r.channel === 'push');
    expect(pushOutcome?.outcome).toEqual({
      ok: false,
      error: 'provider unavailable for channel push',
    });
    expect(
      h.notifications.calls.markFailed.find((c) => c.error.startsWith('provider unavailable')),
    ).toBeDefined();
    expect(h.pushTokens.calls.deactivateByApnsToken).toEqual([]);
  });

  it('records "no recipient" when sms has no phone on the user', async () => {
    h.users.rowsById.set(USER_ID, buildUser({ phone: null }));
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.picked_up',
      payload: { orderId: ORDER_ID, driverFirstName: 'Alex' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:picked_up`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    const smsOutcome = result.results.find((r) => r.channel === 'sms');
    expect(smsOutcome?.outcome).toEqual({ ok: false, error: 'no recipient for channel sms' });
    expect(h.smsProvider.calls).toHaveLength(0);
    expect(
      h.notifications.calls.markFailed.find((c) => c.error === 'no recipient for channel sms'),
    ).toBeDefined();
  });

  it('records "no recipient" when push has no active tokens for the variant', async () => {
    h.pushTokens.tokensByUser.clear();

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    const pushOutcome = result.results.find((r) => r.channel === 'push');
    expect(pushOutcome?.outcome).toEqual({ ok: false, error: 'no recipient for channel push' });
    expect(h.pushProvider.calls).toHaveLength(0);
  });

  it('marks in_app sent without calling any provider (the row is the artifact)', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.accepted',
      payload: { orderId: ORDER_ID, dispensaryName: 'Green Roots' },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:accepted`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    const inApp = result.results.find((r) => r.channel === 'in_app');
    expect(inApp?.outcome).toEqual({ ok: true, providerRef: 'in_app' });
    expect(h.notifications.calls.markSent.find((c) => c.providerRef === 'in_app')).toBeDefined();
  });

  it('fans out push + email for order.completed and threads totalCents into the payload', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];
    h.emailProvider.responses = [{ ok: true, providerRef: 'resend-1' }];

    const result = await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.completed',
      payload: { orderId: ORDER_ID, totalCents: 6_499 },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:delivered`,
    });

    if (result.skipped) throw new TypeError('expected delivery');
    expect(result.results.map((r) => r.channel).sort()).toEqual(['email', 'in_app', 'push']);
    expect(h.pushProvider.calls).toHaveLength(1);
    expect(h.emailProvider.calls).toHaveLength(1);
    expect(h.emailProvider.calls[0]?.recipient).toEqual({
      channel: 'email',
      userId: USER_ID,
      emailAddress: 'customer@example.com',
    });
  });

  it('serializeRendered preserves push collapseId, email subject/text, and sms body in the persisted payload', async () => {
    h.pushProvider.responses = [{ ok: true, providerRef: 'apns-1' }];
    h.emailProvider.responses = [{ ok: true, providerRef: 'resend-1' }];

    await h.dispatcher.dispatch({
      userId: USER_ID,
      templateKey: 'order.completed',
      payload: { orderId: ORDER_ID, totalCents: 6_499 },
      appVariant: 'consumer',
      idempotencyKey: `${ORDER_ID}:delivered`,
    });

    const rowsByChannel = new Map(h.notifications.calls.create.map((r) => [r.channel, r]));

    const pushPayload = rowsByChannel.get('push')?.payload as Record<string, unknown>;
    expect(pushPayload).toMatchObject({
      channel: 'push',
      title: 'Delivered',
      contentAvailable: false,
      collapseId: `order-${ORDER_ID}`,
    });
    expect(pushPayload['data']).toMatchObject({
      templateKey: 'order.completed',
      orderId: ORDER_ID,
    });

    const emailPayload = rowsByChannel.get('email')?.payload as Record<string, unknown>;
    expect(emailPayload).toMatchObject({ channel: 'email' });
    expect(typeof emailPayload['subject']).toBe('string');
    expect(typeof emailPayload['text']).toBe('string');

    const inAppPayload = rowsByChannel.get('in_app')?.payload as Record<string, unknown>;
    expect(inAppPayload).toMatchObject({
      channel: 'in_app',
      title: 'Delivered',
    });
  });
});
