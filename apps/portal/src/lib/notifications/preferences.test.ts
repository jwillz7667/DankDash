import { describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_MUTE_STORAGE_KEY,
  getSessionStorage,
  readMuted,
  writeMuted,
  type NotificationPreferencesStorage,
} from './preferences.js';

function makeStorage(initial: Record<string, string> = {}): NotificationPreferencesStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key: string): string | null => (key in data ? (data[key] ?? null) : null),
    setItem: (key: string, value: string): void => {
      data[key] = value;
    },
    removeItem: (key: string): void => {
      Reflect.deleteProperty(data, key);
    },
  };
}

describe('readMuted', () => {
  it('returns false when storage is null (SSR)', () => {
    expect(readMuted(null)).toBe(false);
  });

  it("returns false when the key isn't present (default alerts on)", () => {
    expect(readMuted(makeStorage())).toBe(false);
  });

  it('returns true when the storage key holds the sentinel "1"', () => {
    expect(readMuted(makeStorage({ [NOTIFICATION_MUTE_STORAGE_KEY]: '1' }))).toBe(true);
  });

  it('returns false for any value other than "1" (defensive against legacy writes)', () => {
    expect(readMuted(makeStorage({ [NOTIFICATION_MUTE_STORAGE_KEY]: 'true' }))).toBe(false);
    expect(readMuted(makeStorage({ [NOTIFICATION_MUTE_STORAGE_KEY]: 'yes' }))).toBe(false);
    expect(readMuted(makeStorage({ [NOTIFICATION_MUTE_STORAGE_KEY]: '' }))).toBe(false);
  });

  it('returns false (does not throw) when storage.getItem throws (private mode)', () => {
    const blowsUp: NotificationPreferencesStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(readMuted(blowsUp)).toBe(false);
  });
});

describe('writeMuted', () => {
  it('is a no-op when storage is null', () => {
    expect(() => {
      writeMuted(null, true);
    }).not.toThrow();
  });

  it('persists muted=true under the sentinel "1"', () => {
    const storage = makeStorage();
    writeMuted(storage, true);
    expect(storage.data[NOTIFICATION_MUTE_STORAGE_KEY]).toBe('1');
  });

  it('removes the key when muted=false to keep storage clean', () => {
    const storage = makeStorage({ [NOTIFICATION_MUTE_STORAGE_KEY]: '1' });
    writeMuted(storage, false);
    expect(storage.data[NOTIFICATION_MUTE_STORAGE_KEY]).toBeUndefined();
  });

  it('does not throw when the underlying storage write fails (quota / sandbox)', () => {
    const blowsUp: NotificationPreferencesStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(() => {
      writeMuted(blowsUp, true);
    }).not.toThrow();
  });

  it('round-trips: writeMuted then readMuted observes the same value', () => {
    const storage = makeStorage();
    writeMuted(storage, true);
    expect(readMuted(storage)).toBe(true);
    writeMuted(storage, false);
    expect(readMuted(storage)).toBe(false);
  });
});

describe('getSessionStorage', () => {
  it('returns the global sessionStorage instance when present (jsdom)', () => {
    expect(getSessionStorage()).toBe(window.sessionStorage);
  });

  it('returns null when sessionStorage access throws (sandboxed iframe)', () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getSessionStorage()).toBeNull();
    spy.mockRestore();
  });
});
