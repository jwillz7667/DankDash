'use client';

/**
 * React hooks for the realtime client.
 *
 * `useRealtimeOrders` is the primary subscription the order queue
 * (Phase 14) consumes — but the shape is finalized here so the
 * Phase 13 shell has a working live connection out of the box, even
 * before the queue UI exists.
 *
 * The hook owns:
 *
 *   1. **Socket lifecycle.** Opens on mount, closes on unmount; one
 *      socket per `(url, token, dispensaryId)` tuple.
 *   2. **Status reporting.** Exposes `idle/connecting/connected/...`
 *      so the UI can paint a "Live" / "Polling" badge per Phase 14.4.
 *   3. **Event handlers.** Callers pass `onCreated` / `onStatusChanged`
 *      and the hook keeps the underlying socket subscriptions in sync
 *      with the latest handlers (a re-render with a new closure
 *      replaces the old subscription, no leaks).
 */
import { useEffect, useRef, useState } from 'react';
import {
  RealtimeClient,
  type DriverLocation,
  type OrderStatusChange,
  type OrderSummary,
  type RealtimeStatus,
} from './client.js';

export interface UseRealtimeOrdersOptions {
  readonly url: string;
  readonly token: string;
  readonly dispensaryId?: string;
  readonly onCreated?: (payload: OrderSummary) => void;
  readonly onStatusChanged?: (payload: OrderStatusChange) => void;
  /**
   * Disable connection entirely. Useful for SSR (no token) and tests
   * where you want to mount the hook but never reach the network.
   */
  readonly enabled?: boolean;
  readonly clientFactory?: (opts: {
    readonly url: string;
    readonly token: string;
    readonly dispensaryId?: string;
  }) => RealtimeClient;
}

export interface UseRealtimeOrdersResult {
  readonly status: RealtimeStatus;
}

export function useRealtimeOrders(options: UseRealtimeOrdersOptions): UseRealtimeOrdersResult {
  const { url, token, dispensaryId, onCreated, onStatusChanged, enabled = true } = options;
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const createdRef = useRef(onCreated);
  const statusChangedRef = useRef(onStatusChanged);

  useEffect(() => {
    createdRef.current = onCreated;
  }, [onCreated]);
  useEffect(() => {
    statusChangedRef.current = onStatusChanged;
  }, [onStatusChanged]);

  useEffect(() => {
    if (!enabled || token.length === 0) {
      setStatus('idle');
      return;
    }

    const client = options.clientFactory
      ? options.clientFactory({
          url,
          token,
          ...(dispensaryId !== undefined ? { dispensaryId } : {}),
        })
      : new RealtimeClient({
          url,
          token,
          ...(dispensaryId !== undefined ? { dispensaryId } : {}),
        });

    const unsubStatus = client.onStatusChange((next) => {
      setStatus(next);
    });
    client.connect();

    const unsubCreated = client.on('order:created', (payload) => {
      createdRef.current?.(payload);
    });
    const unsubStatusEvent = client.on('order:status_changed', (payload) => {
      statusChangedRef.current?.(payload);
    });

    return () => {
      unsubStatus();
      unsubCreated();
      unsubStatusEvent();
      client.disconnect();
    };
    // We intentionally omit `onCreated`/`onStatusChanged` from this
    // dependency list — keeping the socket lifecycle keyed to
    // identity-stable inputs only avoids tearing down + recreating
    // on every render. The refs above bridge the latest handlers
    // through without re-subscribing.
  }, [url, token, dispensaryId, enabled, options.clientFactory]);

  return { status };
}

export interface UseDriverLocationOptions {
  readonly url: string;
  readonly token: string;
  readonly dispensaryId?: string;
  /**
   * Only `driver:location` events whose `orderId` matches are surfaced —
   * one vendor socket sees every active delivery for the dispensary, so
   * the per-order map filters down to its own order.
   */
  readonly orderId: string;
  readonly enabled?: boolean;
  readonly clientFactory?: (opts: {
    readonly url: string;
    readonly token: string;
    readonly dispensaryId?: string;
  }) => RealtimeClient;
}

export interface UseDriverLocationResult {
  readonly status: RealtimeStatus;
  /** Latest matching driver location, or null until the first tick. */
  readonly location: DriverLocation | null;
}

/**
 * Subscribe to live driver GPS for one order. Owns the socket lifecycle
 * (mirrors `useRealtimeOrders`) and keeps only the latest location for
 * `orderId` in state — the per-order delivery map re-renders the marker
 * off it. Returns `{ status, location }`; `location` is null until the
 * first matching tick (the map paints pickup + dropoff from the SSR
 * snapshot meanwhile).
 */
export function useDriverLocation(options: UseDriverLocationOptions): UseDriverLocationResult {
  const { url, token, dispensaryId, orderId, enabled = true } = options;
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [location, setLocation] = useState<DriverLocation | null>(null);
  const orderIdRef = useRef(orderId);

  useEffect(() => {
    orderIdRef.current = orderId;
  }, [orderId]);

  useEffect(() => {
    if (!enabled || token.length === 0) {
      setStatus('idle');
      return;
    }

    const client = options.clientFactory
      ? options.clientFactory({
          url,
          token,
          ...(dispensaryId !== undefined ? { dispensaryId } : {}),
        })
      : new RealtimeClient({
          url,
          token,
          ...(dispensaryId !== undefined ? { dispensaryId } : {}),
        });

    const unsubStatus = client.onStatusChange((next) => {
      setStatus(next);
    });
    client.connect();

    const unsubLocation = client.on('driver:location', (payload) => {
      if (payload.orderId === orderIdRef.current) {
        setLocation(payload);
      }
    });

    return () => {
      unsubStatus();
      unsubLocation();
      client.disconnect();
    };
  }, [url, token, dispensaryId, enabled, options.clientFactory]);

  return { status, location };
}
