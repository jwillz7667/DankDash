/**
 * Phase 10.2 geofence arrival trigger.
 *
 * The location-ingest consumer fires an `onCommitted` callback per item
 * after a batch's Postgres write has succeeded and the stream entries
 * have been XACKed. This observer is what we hand to that hook — it
 * decides, for one just-committed location ping, whether the driver has
 * arrived at their dropoff and, if so, transitions the order to
 * `arrived_at_dropoff` through the authoritative state machine.
 *
 * The trigger is fundamentally idempotent for two layered reasons:
 *
 *   1. **Cheap pre-check.** The state machine only allows
 *      `DRIVER_ARRIVED` from `en_route_dropoff`. We read the current
 *      order status before opening a transaction; orders already at
 *      `arrived_at_dropoff` or beyond short-circuit out without a row
 *      lock or audit-trail write. This is the path the vast majority of
 *      "second / third / Nth ping inside the geofence" calls take.
 *
 *   2. **Authoritative race resolution.** When two pings inside the
 *      geofence are in flight concurrently and both pass the pre-check,
 *      they both call `OrdersRepository.applyTransition`. That call
 *      `SELECT … FOR UPDATE`s the row and re-runs the state-machine
 *      resolver under the lock — the second caller sees the
 *      post-transition status, the resolver throws
 *      `ORDER_INVALID_TRANSITION`, the tx rolls back, and we catch the
 *      `OrderError` here without re-throwing. Same pattern the dispatch
 *      worker uses to mark `dispatch_failed`.
 *
 * Observer failures must not poison the consumer — the location-ingest
 * consumer wraps `onCommitted` in `Promise.allSettled` and only logs
 * rejections. We still rethrow non-OrderError exceptions so the
 * upstream warn-log captures them; the persistence already succeeded
 * either way.
 */
import { type Logger } from '@dankdash/config';
import { type OrdersRepository } from '@dankdash/db';
import { OrderError, nextOrderState } from '@dankdash/orders';
import {
  ARRIVAL_THRESHOLD_METERS,
  extractDropoffPoint,
  isWithinArrivalThreshold,
} from './geofence.service.js';
import type { LocationIngestItem } from './types.js';

export interface GeofenceObserverDeps {
  readonly orders: OrdersRepository;
  readonly logger: Logger;
  /**
   * Override the 50m threshold — used by tests to assert boundary
   * behaviour deterministically. Production always uses the spec default.
   */
  readonly arrivalThresholdMeters?: number;
}

export type GeofenceObserver = (item: LocationIngestItem) => Promise<void>;

export function createGeofenceObserver(deps: GeofenceObserverDeps): GeofenceObserver {
  const log = deps.logger.child({ job: 'geofence' });
  const threshold = deps.arrivalThresholdMeters ?? ARRIVAL_THRESHOLD_METERS;

  return async function onLocationCommitted(item: LocationIngestItem): Promise<void> {
    const { orderId, driverId, lat, lng, recordedAt } = item.payload;
    // Drivers go on duty before they're assigned an order, and continue
    // pinging between trips. A null orderId is the common case — silent
    // skip is correct.
    if (orderId === null) return;

    const order = await deps.orders.findById(orderId);
    if (order === null) {
      // Order vanished between the ping and our read — could be a hard
      // delete in a test seed, never in production. Skip rather than
      // throw; the observer's failure mode is "miss this arrival, next
      // ping at 1Hz will catch it" anyway.
      return;
    }

    // Pre-check before paying for the row lock. The vast majority of
    // pings carry an orderId for an order that's not yet at the dropoff
    // (en_route_pickup, picked_up) or has already arrived
    // (arrived_at_dropoff and beyond). Short-circuit here.
    if (order.status !== 'en_route_dropoff') return;

    // The realtime layer trusts the client's claim about which order
    // they're delivering, but dispatch can reassign the order between
    // the ping leaving the device and our committing the position. The
    // DB row is authoritative — if it doesn't agree, skip.
    if (order.driverId !== driverId) {
      log.warn(
        { orderId, payloadDriverId: driverId, orderDriverId: order.driverId },
        'geofence: ping references order whose driver_id no longer matches — skipping',
      );
      return;
    }

    const dropoff = extractDropoffPoint(order.deliveryAddressSnapshot);
    if (dropoff === null) {
      log.warn(
        { orderId, driverId },
        'geofence: order delivery_address_snapshot has no usable location — skipping',
      );
      return;
    }

    if (!isWithinArrivalThreshold({ lat, lng }, dropoff, threshold)) return;

    try {
      await deps.orders.applyTransition(orderId, (locked) => ({
        toStatus: nextOrderState(locked.status, 'DRIVER_ARRIVED'),
        eventType: 'DRIVER_ARRIVED',
        actorUserId: locked.driverId ?? undefined,
        actorRole: 'driver',
        payload: {
          trigger: 'geofence',
          lat,
          lng,
          recordedAt,
          thresholdMeters: threshold,
        },
      }));
      log.info(
        { orderId, driverId, recordedAt },
        'geofence: driver inside arrival threshold — order transitioned to arrived_at_dropoff',
      );
    } catch (err) {
      if (err instanceof OrderError) {
        // Race lost — either an earlier ping already transitioned (this
        // ping is a duplicate inside the geofence), the driver tapped
        // "I'm here" first, or the order moved to a terminal state
        // between our pre-check and the row lock. Benign; the audit
        // trail records the winning transition either way.
        log.debug(
          { orderId, code: err.code },
          'geofence: arrival transition lost race — already fired or order moved on',
        );
        return;
      }
      throw err;
    }
  };
}
