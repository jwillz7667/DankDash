/**
 * Per-session mute preference for new-order alerts.
 *
 * The spec is explicit (Phase 14.3, CLAUDE-CODE-PHASES.md):
 *
 *   > Cannot mute notifications per-account, only per-session
 *
 * So the toggle lives in `sessionStorage` rather than `localStorage` or
 * a server-side user preference — close the tab and the mute clears
 * itself. Operators have to make a conscious choice every shift, which
 * is the intended behavior (a forgotten mute that survives a reboot is
 * how a busy dispensary misses an order).
 *
 * Pure module — `Storage` is passed in so the React hook layer can
 * inject `window.sessionStorage` at the boundary and tests can pass an
 * in-memory fake. The SSR pre-paint reads `null` and degrades to "not
 * muted", which is the safe default (better to over-notify than to
 * silently swallow a new order during hydration).
 */
const STORAGE_KEY = 'dankdash:portal:notifications:muted';

/**
 * Subset of the DOM `Storage` interface we touch. Narrowed so tests
 * can supply a minimal stub without implementing `length` / `clear` /
 * the indexed access getters.
 */
export interface NotificationPreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read the muted flag from storage. Returns `false` when storage is
 * unavailable or the key is absent — the default is "alerts on".
 */
export function readMuted(storage: NotificationPreferencesStorage | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(STORAGE_KEY) === '1';
  } catch (error) {
    // Safari private-mode and sandboxed iframes throw on access rather
    // than returning null. We treat that as "unable to persist" and
    // fall back to the default — the in-memory React state above this
    // layer remains authoritative for the current render.
    void error;
    return false;
  }
}

/**
 * Write the muted flag to storage. Idempotent and resilient — a quota
 * or access error is swallowed because the React state is the source
 * of truth for the current paint; persistence is best-effort.
 */
export function writeMuted(storage: NotificationPreferencesStorage | null, muted: boolean): void {
  if (storage === null) return;
  try {
    if (muted) {
      storage.setItem(STORAGE_KEY, '1');
    } else {
      storage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    void error;
  }
}

/**
 * Return the browser's `sessionStorage` or `null` when not running in
 * a browser (SSR) or when storage is blocked. The check is inside a
 * try/catch because the property access itself throws in sandboxed
 * iframes — checking `typeof` alone is not enough.
 */
export function getSessionStorage(): NotificationPreferencesStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    void error;
    return null;
  }
}

export const NOTIFICATION_MUTE_STORAGE_KEY = STORAGE_KEY;
