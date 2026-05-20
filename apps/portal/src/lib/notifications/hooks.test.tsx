import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ChimePlayer } from './audio.js';
import {
  useChimePlayer,
  useNotificationPermission,
  useNotificationPreferences,
  useOrderAlert,
  type UseOrderAlertResult,
} from './hooks.js';
import { NOTIFICATION_MUTE_STORAGE_KEY } from './preferences.js';
import type { OrderNotificationPayload } from './browser.js';

function HostPreferences({
  onResult,
}: {
  readonly onResult: (r: ReturnType<typeof useNotificationPreferences>) => void;
}): ReactNode {
  onResult(useNotificationPreferences());
  return null;
}

function HostPermission({
  onResult,
}: {
  readonly onResult: (r: ReturnType<typeof useNotificationPermission>) => void;
}): ReactNode {
  onResult(useNotificationPermission());
  return null;
}

function HostChime({
  onResult,
  factory,
}: {
  readonly onResult: (r: ChimePlayer) => void;
  readonly factory: () => ChimePlayer;
}): ReactNode {
  onResult(useChimePlayer({ playerFactory: factory }));
  return null;
}

function HostAlert({
  onResult,
  factory,
}: {
  readonly onResult: (r: UseOrderAlertResult) => void;
  readonly factory: () => ChimePlayer;
}): ReactNode {
  onResult(useOrderAlert({ playerFactory: factory }));
  return null;
}

function fakePlayer(): ChimePlayer & {
  readonly plays: { count: number };
  readonly primes: { count: number };
  readonly disposes: { count: number };
} {
  const plays = { count: 0 };
  const primes = { count: 0 };
  const disposes = { count: 0 };
  return {
    plays,
    primes,
    disposes,
    play: vi.fn(async () => {
      plays.count += 1;
    }),
    prime: vi.fn(async () => {
      primes.count += 1;
    }),
    dispose: vi.fn(async () => {
      disposes.count += 1;
    }),
  };
}

interface FakeNotificationInstance {
  title: string;
  tag?: string;
  onclick: ((event: unknown) => void) | null;
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
  function Fake(
    this: FakeNotificationInstance,
    title: string,
    options?: NotificationOptions,
  ): void {
    this.title = title;
    if (options?.tag !== undefined) (this as { tag?: string }).tag = options.tag;
    this.onclick = null;
    instances.push(this);
  }
  Fake.permission = initial;
  Fake.requestPermission = vi.fn(async () => Fake.permission);
  Fake.instances = instances;
  (globalThis as unknown as { Notification: FakeNotificationCtor }).Notification =
    Fake as unknown as FakeNotificationCtor;
  return Fake as unknown as FakeNotificationCtor;
}

function uninstallNotification(): void {
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
}

function payload(overrides: Partial<OrderNotificationPayload> = {}): OrderNotificationPayload {
  return {
    orderId: 'order-1',
    shortCode: 'A1B2',
    totalCents: 1000,
    customerName: 'Mia',
    ...overrides,
  };
}

describe('useNotificationPreferences', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('starts unmuted by default when storage is clean', () => {
    let captured: ReturnType<typeof useNotificationPreferences> | null = null;
    render(<HostPreferences onResult={(r) => (captured = r)} />);
    expect(captured!.isMuted).toBe(false);
  });

  it('rehydrates the muted flag from sessionStorage on mount', () => {
    window.sessionStorage.setItem(NOTIFICATION_MUTE_STORAGE_KEY, '1');
    let captured: ReturnType<typeof useNotificationPreferences> | null = null;
    render(<HostPreferences onResult={(r) => (captured = r)} />);
    expect(captured!.isMuted).toBe(true);
  });

  it('setMuted writes through to sessionStorage', () => {
    let captured: ReturnType<typeof useNotificationPreferences> | null = null;
    render(<HostPreferences onResult={(r) => (captured = r)} />);
    act(() => {
      captured!.setMuted(true);
    });
    expect(window.sessionStorage.getItem(NOTIFICATION_MUTE_STORAGE_KEY)).toBe('1');
    expect(captured!.isMuted).toBe(true);
  });

  it('toggleMuted flips the flag and persists each transition', () => {
    let captured: ReturnType<typeof useNotificationPreferences> | null = null;
    render(<HostPreferences onResult={(r) => (captured = r)} />);
    act(() => {
      captured!.toggleMuted();
    });
    expect(captured!.isMuted).toBe(true);
    expect(window.sessionStorage.getItem(NOTIFICATION_MUTE_STORAGE_KEY)).toBe('1');
    act(() => {
      captured!.toggleMuted();
    });
    expect(captured!.isMuted).toBe(false);
    expect(window.sessionStorage.getItem(NOTIFICATION_MUTE_STORAGE_KEY)).toBeNull();
  });
});

describe('useNotificationPermission', () => {
  afterEach(() => {
    uninstallNotification();
  });

  it('starts "unsupported" before mount effects run and resolves to the live value', () => {
    installFakeNotification('granted');
    let captured: ReturnType<typeof useNotificationPermission> | null = null;
    render(<HostPermission onResult={(r) => (captured = r)} />);
    expect(captured!.permission).toBe('granted');
  });

  it('request() awaits the underlying prompt and updates the React state', async () => {
    const fake = installFakeNotification('default');
    fake.requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    let captured: ReturnType<typeof useNotificationPermission> | null = null;
    render(<HostPermission onResult={(r) => (captured = r)} />);
    expect(captured!.permission).toBe('default');

    let resolved: string | null = null;
    await act(async () => {
      resolved = await captured!.request();
    });
    expect(resolved).toBe('granted');
    expect(captured!.permission).toBe('granted');
  });
});

describe('useChimePlayer', () => {
  it('builds the player exactly once across renders and disposes on unmount', () => {
    const built: ChimePlayer[] = [];
    const factory = (): ChimePlayer => {
      const p = fakePlayer();
      built.push(p);
      return p;
    };
    let captured: ChimePlayer | null = null;
    const { rerender, unmount } = render(
      <HostChime onResult={(r) => (captured = r)} factory={factory} />,
    );
    expect(built).toHaveLength(1);
    const first = captured;

    rerender(<HostChime onResult={(r) => (captured = r)} factory={factory} />);
    expect(built).toHaveLength(1);
    expect(captured).toBe(first);

    unmount();
    expect((built[0] as ReturnType<typeof fakePlayer>).disposes.count).toBe(1);
  });
});

describe('useOrderAlert', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    uninstallNotification();
  });

  it('trigger() plays the chime and shows a notification when granted + unmuted', () => {
    const player = fakePlayer();
    const fake = installFakeNotification('granted');
    let captured: UseOrderAlertResult | null = null;
    render(<HostAlert onResult={(r) => (captured = r)} factory={(): ChimePlayer => player} />);

    act(() => {
      captured!.trigger(payload({ orderId: 'order-x' }));
    });

    expect(player.plays.count).toBe(1);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]?.tag).toBe('dankdash-order-order-x');
  });

  it('skips both chime and notification when muted', () => {
    const player = fakePlayer();
    const fake = installFakeNotification('granted');
    let captured: UseOrderAlertResult | null = null;
    render(<HostAlert onResult={(r) => (captured = r)} factory={(): ChimePlayer => player} />);

    act(() => {
      captured!.setMuted(true);
    });
    act(() => {
      captured!.trigger(payload());
    });

    expect(player.plays.count).toBe(0);
    expect(fake.instances).toHaveLength(0);
  });

  it('plays the chime even when notification permission is "default" (audio-only mode)', () => {
    const player = fakePlayer();
    const fake = installFakeNotification('default');
    let captured: UseOrderAlertResult | null = null;
    render(<HostAlert onResult={(r) => (captured = r)} factory={(): ChimePlayer => player} />);

    act(() => {
      captured!.trigger(payload());
    });
    expect(player.plays.count).toBe(1);
    expect(fake.instances).toHaveLength(0);
  });

  it('primeFromGesture forwards to the underlying chime player', () => {
    const player = fakePlayer();
    let captured: UseOrderAlertResult | null = null;
    render(<HostAlert onResult={(r) => (captured = r)} factory={(): ChimePlayer => player} />);
    act(() => {
      captured!.primeFromGesture();
    });
    expect(player.primes.count).toBe(1);
  });

  it('requestPermission() drives the permission state forward', async () => {
    const player = fakePlayer();
    const fake = installFakeNotification('default');
    fake.requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    let captured: UseOrderAlertResult | null = null;
    render(<HostAlert onResult={(r) => (captured = r)} factory={(): ChimePlayer => player} />);
    expect(captured!.permission).toBe('default');
    await act(async () => {
      await captured!.requestPermission();
    });
    expect(captured!.permission).toBe('granted');
  });
});
