import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationPermission,
  requestNotificationPermission,
  showOrderNotification,
  type OrderNotificationPayload,
} from './browser.js';

interface FakeNotificationInstance {
  title: string;
  body?: string;
  tag?: string;
  onclick: ((this: FakeNotificationInstance, event: unknown) => unknown) | null;
}

interface FakeNotificationCtor {
  (this: FakeNotificationInstance, title: string, options?: NotificationOptions): void;
  permission: NotificationPermission;
  requestPermission: (
    cb?: (permission: NotificationPermission) => void,
  ) => Promise<NotificationPermission>;
  instances: FakeNotificationInstance[];
}

function installFakeNotification(
  initial: NotificationPermission = 'default',
): FakeNotificationCtor {
  const instances: FakeNotificationInstance[] = [];

  function FakeNotification(
    this: FakeNotificationInstance,
    title: string,
    options?: NotificationOptions,
  ): void {
    this.title = title;
    if (options?.body !== undefined) {
      (this as { body?: string }).body = options.body;
    }
    if (options?.tag !== undefined) {
      (this as { tag?: string }).tag = options.tag;
    }
    this.onclick = null;
    instances.push(this);
  }
  FakeNotification.permission = initial;
  FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
  FakeNotification.instances = instances;

  (globalThis as unknown as { Notification: FakeNotificationCtor }).Notification =
    FakeNotification as unknown as FakeNotificationCtor;
  return FakeNotification as unknown as FakeNotificationCtor;
}

function uninstallNotification(): void {
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
}

function payload(overrides: Partial<OrderNotificationPayload> = {}): OrderNotificationPayload {
  return {
    orderId: '01935f3d-0000-7000-8000-000000000001',
    shortCode: 'A1B2',
    totalCents: 6210,
    customerName: 'Mia Reyes',
    ...overrides,
  };
}

describe('getNotificationPermission', () => {
  afterEach(() => {
    uninstallNotification();
  });

  it('returns "unsupported" when the Notification API is absent', () => {
    uninstallNotification();
    expect(getNotificationPermission()).toBe('unsupported');
  });

  it('returns the live Notification.permission value when available', () => {
    installFakeNotification('granted');
    expect(getNotificationPermission()).toBe('granted');
  });

  it('returns "unsupported" if the permission getter throws (sandboxed iframe)', () => {
    const fake = installFakeNotification('default');
    Object.defineProperty(fake, 'permission', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(getNotificationPermission()).toBe('unsupported');
  });
});

describe('requestNotificationPermission', () => {
  afterEach(() => {
    uninstallNotification();
  });

  it('returns "unsupported" when the API is missing', async () => {
    uninstallNotification();
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });

  it('delegates to Notification.requestPermission and returns the result', async () => {
    const fake = installFakeNotification('default');
    fake.requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('returns "denied" when the underlying request rejects', async () => {
    const fake = installFakeNotification('default');
    fake.requestPermission = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });
});

describe('showOrderNotification', () => {
  beforeEach(() => {
    uninstallNotification();
  });

  afterEach(() => {
    uninstallNotification();
  });

  it('returns null and does not construct anything when permission != granted', () => {
    installFakeNotification('default');
    expect(showOrderNotification(payload())).toBeNull();

    installFakeNotification('denied');
    expect(showOrderNotification(payload())).toBeNull();
  });

  it('returns null when the API is unsupported entirely', () => {
    uninstallNotification();
    expect(showOrderNotification(payload())).toBeNull();
  });

  it('renders a toast with the formatted title and body when granted', () => {
    const fake = installFakeNotification('granted');
    showOrderNotification(payload());
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]?.title).toBe('New order #A1B2');
    expect(fake.instances[0]?.body).toBe('Mia Reyes · $62.10');
  });

  it('falls back to "Guest customer" when the payload omits a name', () => {
    const fake = installFakeNotification('granted');
    showOrderNotification(payload({ customerName: null }));
    expect(fake.instances[0]?.body).toBe('Guest customer · $62.10');
  });

  it('uses a stable per-order tag for browser-side deduplication', () => {
    const fake = installFakeNotification('granted');
    showOrderNotification(payload({ orderId: 'abc-123' }));
    expect(fake.instances[0]?.tag).toBe('dankdash-order-abc-123');
  });

  it('formats whole-dollar amounts with two decimal places', () => {
    const fake = installFakeNotification('granted');
    showOrderNotification(payload({ totalCents: 5000 }));
    expect(fake.instances[0]?.body).toContain('$50.00');
  });

  it('formats sub-dollar amounts correctly', () => {
    const fake = installFakeNotification('granted');
    showOrderNotification(payload({ totalCents: 7 }));
    expect(fake.instances[0]?.body).toContain('$0.07');
  });

  it('returns null when the Notification constructor throws', () => {
    installFakeNotification('granted');
    (globalThis as unknown as { Notification: unknown }).Notification = function (): void {
      throw new Error('TypeError');
    };
    expect(showOrderNotification(payload())).toBeNull();
  });

  it('wires onclick: the provided callback receives the payload', () => {
    const fake = installFakeNotification('granted');
    const onClick = vi.fn();
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => undefined);

    const notification = showOrderNotification(payload({ orderId: 'order-x' }), { onClick });
    expect(notification).not.toBeNull();

    notification?.onclick?.call(notification, new Event('click'));
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-x' }) as unknown as OrderNotificationPayload,
    );
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
    void fake;
  });

  it('still invokes onClick when window.focus() throws', () => {
    installFakeNotification('granted');
    const onClick = vi.fn();
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {
      throw new Error('NotAllowedError');
    });

    const notification = showOrderNotification(payload(), { onClick });
    notification?.onclick?.call(notification, new Event('click'));
    expect(onClick).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
  });
});
