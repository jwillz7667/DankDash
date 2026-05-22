'use client';

/**
 * Polling-fallback for the realtime order queue (Phase 14.4).
 *
 * When the Socket.io connection drops to `disconnected` or `error`
 * long enough for the grace window to expire, the board switches to
 * REST polling against `GET /v1/vendor/orders` on a fixed interval.
 * Polling continues until the socket reconnects, at which point the
 * hook cancels the timer and the realtime stream resumes.
 *
 * Design choices worth a comment:
 *
 *   - **Grace window** before the first poll. A brief WS hiccup
 *     (process restart, mobile network blip) usually resolves inside a
 *     handful of seconds via the underlying socket's reconnect logic.
 *     Polling immediately would burn API requests for no benefit and
 *     would also flicker the badge label. Default 10s — long enough
 *     to ride out normal reconnects, short enough that a real outage
 *     gets a snapshot inside one polling cycle.
 *
 *   - **In-flight discard** on disable. The fetcher is async, so a
 *     poll fired at T=N can resolve at T=N+rtt. If the socket
 *     reconnects between the fire and the resolve, the response is
 *     stale relative to the live channel and must NOT overwrite the
 *     snapshot. We track each in-flight poll with a token; when the
 *     hook disables (or unmounts), tokens are invalidated and any
 *     late-arriving response is dropped on the floor.
 *
 *   - **No retry/backoff**. Errors are surfaced via the result
 *     object so the UI can choose to display them, but the polling
 *     loop itself is unaffected — the next tick fires regardless.
 *     The next successful response folds whatever drifted while the
 *     previous one was failing. A failing endpoint won't escalate
 *     into a tight loop because the interval is fixed.
 *
 *   - **Single-flight per interval**. If a poll is still in flight
 *     when the next tick would fire, the tick is skipped. This
 *     prevents a slow API from queueing requests indefinitely while
 *     the operator's tab sits in the background.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueueSnapshotPollingResult<T> {
  /**
   * `true` while the polling timer is active (after the grace
   * window). Used by the realtime badge to flip from "Reconnecting"
   * to "Polling" so the operator knows data is still flowing through
   * the fallback.
   */
  readonly active: boolean;
  /** Last error from a poll attempt, or `null` if the latest poll succeeded. */
  readonly error: Error | null;
  /** Wall-clock of the last *successful* poll, or `null` before the first one lands. */
  readonly lastPolledAt: Date | null;
  /** Force a poll right now (e.g. from an explicit "Refresh" button). No-op if disabled. */
  readonly poll: () => Promise<T | null>;
}

export interface UseQueueSnapshotPollingOptions<T> {
  /**
   * Whether the polling loop should be running. The board flips this
   * to `true` when the realtime status is `disconnected`/`error` and
   * back to `false` when it returns to `connected`/`idle`.
   */
  readonly enabled: boolean;
  /**
   * Server-side fetcher (typically a Next.js server action) that
   * returns the active queue snapshot. The hook awaits its promise
   * and forwards the result to `onSnapshot`.
   */
  readonly fetcher: () => Promise<T>;
  /**
   * Apply the polled snapshot to the consumer's state. Called once
   * per successful poll; never called for a discarded response.
   */
  readonly onSnapshot: (snapshot: T) => void;
  /** Interval between polls in ms. Defaults to 15_000 per Phase 14.4 spec. */
  readonly intervalMs?: number;
  /**
   * Grace window before the first poll fires after `enabled` flips
   * to `true`. Defaults to 10_000.
   */
  readonly gracePeriodMs?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_GRACE_PERIOD_MS = 10_000;

export function useQueueSnapshotPolling<T>(
  options: UseQueueSnapshotPollingOptions<T>,
): QueueSnapshotPollingResult<T> {
  const {
    enabled,
    fetcher,
    onSnapshot,
    intervalMs = DEFAULT_INTERVAL_MS,
    gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  } = options;

  const [active, setActive] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);

  // Tokenize each polling session. Anything captured at the start of
  // a `runPoll` call compares its token against this ref before
  // calling `setState`. A token mismatch means we've either
  // disabled, unmounted, or restarted — and the response is stale.
  const sessionTokenRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const fetcherRef = useRef(fetcher);
  const onSnapshotRef = useRef(onSnapshot);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  const runPoll = useCallback(async (token: number): Promise<T | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    try {
      const snapshot = await fetcherRef.current();
      // Token check: if `enabled` toggled or the hook restarted, this
      // response is for a session that's no longer the active one.
      if (token !== sessionTokenRef.current) return null;
      onSnapshotRef.current(snapshot);
      setError(null);
      setLastPolledAt(new Date());
      return snapshot;
    } catch (cause) {
      if (token !== sessionTokenRef.current) return null;
      setError(cause instanceof Error ? cause : new Error('Polling fetch failed'));
      return null;
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Stopping: invalidate any in-flight session token, clear
      // surface state, leave the last-polled timestamp intact (the
      // badge tooltip can show it for context after reconnect).
      sessionTokenRef.current += 1;
      setActive(false);
      setError(null);
      return;
    }

    const token = sessionTokenRef.current + 1;
    sessionTokenRef.current = token;

    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const graceHandle = setTimeout(() => {
      if (token !== sessionTokenRef.current) return;
      setActive(true);
      void runPoll(token);
      intervalHandle = setInterval(() => {
        if (token !== sessionTokenRef.current) return;
        void runPoll(token);
      }, intervalMs);
    }, gracePeriodMs);

    return (): void => {
      clearTimeout(graceHandle);
      if (intervalHandle !== null) clearInterval(intervalHandle);
      // Invalidate the token so any in-flight response is discarded.
      sessionTokenRef.current += 1;
      setActive(false);
    };
  }, [enabled, intervalMs, gracePeriodMs, runPoll]);

  const poll = useCallback(async (): Promise<T | null> => {
    if (!enabled) return null;
    return runPoll(sessionTokenRef.current);
  }, [enabled, runPoll]);

  return { active, error, lastPolledAt, poll };
}
