'use client';

/**
 * React hooks that compose the notification primitives:
 *
 *   - `useNotificationPreferences` — session-scoped mute toggle, hydrates
 *     from `sessionStorage` on mount (the SSR pre-paint sees "not
 *     muted", which is the safe default).
 *   - `useNotificationPermission` — current browser permission state +
 *     an async `request()` that updates the React state after the
 *     prompt resolves.
 *   - `useChimePlayer` — singleton chime player keyed off the component
 *     mount; disposes on unmount.
 *
 * These compose into a higher-level `useOrderAlert` in this same file
 * — the board owns a single `useOrderAlert` instance and calls
 * `trigger(payload)` from the `order:created` reducer wrapper.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChimePlayer, type ChimePlayer, type ChimePlayerOptions } from './audio.js';
import {
  getNotificationPermission,
  requestNotificationPermission,
  showOrderNotification,
  type NotificationPermissionState,
  type OrderNotificationPayload,
  type ShowOrderNotificationOptions,
} from './browser.js';
import { getSessionStorage, readMuted, writeMuted } from './preferences.js';

export interface UseNotificationPreferencesResult {
  readonly isMuted: boolean;
  readonly toggleMuted: () => void;
  readonly setMuted: (next: boolean) => void;
}

export function useNotificationPreferences(): UseNotificationPreferencesResult {
  // Lazy default for the first render. SSR / pre-hydration sees this
  // before the storage read lands; "not muted" is the safe choice (an
  // operator who actively muted will see the toggle flip back to the
  // muted icon a tick later — better than silently swallowing the
  // first alert if the default were "muted").
  const [isMuted, setIsMutedState] = useState<boolean>(false);

  useEffect(() => {
    setIsMutedState(readMuted(getSessionStorage()));
  }, []);

  const setMuted = useCallback((next: boolean): void => {
    setIsMutedState(next);
    writeMuted(getSessionStorage(), next);
  }, []);

  const toggleMuted = useCallback((): void => {
    setIsMutedState((prev) => {
      const next = !prev;
      writeMuted(getSessionStorage(), next);
      return next;
    });
  }, []);

  return { isMuted, toggleMuted, setMuted };
}

export interface UseNotificationPermissionResult {
  readonly permission: NotificationPermissionState;
  readonly request: () => Promise<NotificationPermissionState>;
}

export function useNotificationPermission(): UseNotificationPermissionResult {
  const [permission, setPermission] = useState<NotificationPermissionState>('unsupported');

  useEffect(() => {
    setPermission(getNotificationPermission());
  }, []);

  const request = useCallback(async (): Promise<NotificationPermissionState> => {
    const result = await requestNotificationPermission();
    setPermission(result);
    return result;
  }, []);

  return { permission, request };
}

/**
 * Owns the chime player's lifecycle. The factory option exists so
 * tests can substitute a fake `ChimePlayer` without pulling in the
 * Web Audio API mocks.
 */
export interface UseChimePlayerOptions {
  readonly chimeOptions?: ChimePlayerOptions;
  readonly playerFactory?: () => ChimePlayer;
}

export function useChimePlayer(options: UseChimePlayerOptions = {}): ChimePlayer {
  const { chimeOptions, playerFactory } = options;
  const playerRef = useRef<ChimePlayer | null>(null);

  // Build the player exactly once. We intentionally do not key the
  // memo on `playerFactory` / `chimeOptions` — a parent passing inline
  // objects would otherwise rebuild (and dispose) the AudioContext on
  // every render, which Chrome rate-limits aggressively. If consumers
  // need a different player, they should remount the owning component.
  const player = useMemo<ChimePlayer>(
    () => {
      if (playerRef.current !== null) return playerRef.current;
      const next =
        playerFactory !== undefined ? playerFactory() : createChimePlayer(chimeOptions ?? {});
      playerRef.current = next;
      return next;
    },
    // Empty deps is deliberate (see note above).
    [],
  );

  useEffect(() => {
    return (): void => {
      void playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  return player;
}

export interface UseOrderAlertOptions {
  readonly chimeOptions?: ChimePlayerOptions;
  readonly playerFactory?: () => ChimePlayer;
}

export interface UseOrderAlertResult {
  readonly isMuted: boolean;
  readonly toggleMuted: () => void;
  readonly setMuted: (next: boolean) => void;
  readonly permission: NotificationPermissionState;
  readonly requestPermission: () => Promise<NotificationPermissionState>;
  /**
   * Fire the chime and (if permitted) a browser notification. Called
   * by the board on every `order:created` event. No-op when muted.
   */
  readonly trigger: (
    payload: OrderNotificationPayload,
    notifyOptions?: ShowOrderNotificationOptions,
  ) => void;
  /**
   * Synchronously prime the audio context from a user gesture. Wire
   * to every interactive control that the operator can plausibly
   * click before the first alert — once primed, subsequent `trigger`
   * calls make sound without an additional gesture.
   */
  readonly primeFromGesture: () => void;
}

/**
 * Single hook the board uses. Owns mute state, permission state, and
 * the chime player; exposes a `trigger` that respects mute and
 * permission.
 */
export function useOrderAlert(options: UseOrderAlertOptions = {}): UseOrderAlertResult {
  const prefs = useNotificationPreferences();
  const perms = useNotificationPermission();
  const player = useChimePlayer({
    ...(options.chimeOptions !== undefined ? { chimeOptions: options.chimeOptions } : {}),
    ...(options.playerFactory !== undefined ? { playerFactory: options.playerFactory } : {}),
  });

  // Keep a live ref of the mute flag so `trigger`'s identity is stable
  // across paints — useful for callers that pass it into a useEffect
  // dependency list.
  const mutedRef = useRef(prefs.isMuted);
  useEffect(() => {
    mutedRef.current = prefs.isMuted;
  }, [prefs.isMuted]);

  const trigger = useCallback(
    (payload: OrderNotificationPayload, notifyOptions?: ShowOrderNotificationOptions): void => {
      if (mutedRef.current) return;
      void player.play();
      showOrderNotification(payload, notifyOptions);
    },
    [player],
  );

  const primeFromGesture = useCallback((): void => {
    void player.prime();
  }, [player]);

  const { permission, request: requestPermission } = perms;
  const { isMuted, toggleMuted, setMuted } = prefs;

  return {
    isMuted,
    toggleMuted,
    setMuted,
    permission,
    requestPermission,
    trigger,
    primeFromGesture,
  };
}
