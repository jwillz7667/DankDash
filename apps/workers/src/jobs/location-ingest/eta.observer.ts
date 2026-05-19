/**
 * Phase 10.3 customer ETA fan-out.
 *
 * Sibling of the geofence observer: the location-ingest consumer calls
 * `onCommitted(item)` per just-persisted ping; this observer is the
 * half that publishes a `customer:eta_updated` envelope so the iOS
 * tracking screen can render a live "X minutes away".
 *
 * Skip order — all skips are silent except mismatches that hint at a
 * data bug we want to know about:
 *
 *   1. `orderId === null`              → driver-on-duty between trips
 *   2. order not found                 → row vanished (test seed delete)
 *   3. status !== 'en_route_dropoff'   → customer doesn't need an ETA
 *                                        before pickup or after arrival
 *   4. order.driverId !== ping driverId → ping references a re-dispatched
 *                                         order; warn so we notice if it
 *                                         persists
 *   5. no dropoff in snapshot          → legacy / malformed row; warn
 *   6. ETA computation returns ≤ 0     → driver is on top of the dropoff;
 *                                        the geofence observer is about
 *                                        to fire DRIVER_ARRIVED in the
 *                                        same fan-out and a zero/negative
 *                                        ETA would fail schema validation
 *                                        anyway. Silent skip.
 *
 * EtaService is resilient by construction — it always returns a value
 * (cache → mapbox → haversine fallback). The only way `computeEta`
 * throws is a programmer-error path (bad coordinates, etc.); we catch
 * and log so the failure doesn't poison the consumer's per-item
 * Promise.allSettled chain. Same for `publish` — a Redis write failure
 * is logged but never rethrown.
 *
 * Why a `publish` callback instead of a Redis client + `publishRealtimeEvent`
 * imported directly: keeps the observer trivially unit-testable (no Redis
 * fake required) and lets the composition root pick which Redis client to
 * publish on. The workers process keeps the ingest connection separate
 * from the publish connection so the BLOCKing XREADGROUP can't queue
 * behind an XADD.
 */
import { type Logger } from '@dankdash/config';
import { type OrdersRepository } from '@dankdash/db';
import { type LatLng } from '@dankdash/eta';
import {
  type CustomerEtaUpdatedPayload,
  type PublishRealtimeEventInput,
} from '@dankdash/realtime-events';
import { extractDropoffPoint } from './geofence.service.js';
import type { LocationIngestItem } from './types.js';

/**
 * Structural subset of `EtaService` — narrowing here means the test
 * suite can pass a hand-rolled stub without spinning up the real class
 * or its Redis/Mapbox dependencies.
 */
export interface EtaComputer {
  computeEta(
    from: LatLng,
    to: LatLng,
  ): Promise<{
    readonly durationSeconds: number;
    readonly distanceMeters: number;
    readonly source: 'cache' | 'mapbox' | 'fallback';
  }>;
}

export interface EtaObserverDeps {
  readonly orders: OrdersRepository;
  readonly eta: EtaComputer;
  /**
   * Wraps `publishRealtimeEvent(redis, ...)` at the composition root so
   * this observer doesn't need to know which Redis client is used for
   * the publish.
   */
  readonly publish: (input: PublishRealtimeEventInput) => Promise<string>;
  readonly logger: Logger;
  /** Test seam — defaults to uuidv7 in production wiring. */
  readonly idGen: () => string;
  /** Test seam — defaults to `() => new Date()` in production wiring. */
  readonly clock?: () => Date;
}

export type EtaObserver = (item: LocationIngestItem) => Promise<void>;

const defaultClock = (): Date => new Date();

export function createEtaObserver(deps: EtaObserverDeps): EtaObserver {
  const log = deps.logger.child({ job: 'eta' });
  const clock = deps.clock ?? defaultClock;

  return async function onLocationCommitted(item: LocationIngestItem): Promise<void> {
    const { orderId, driverId, lat, lng } = item.payload;
    if (orderId === null) return;

    const order = await deps.orders.findById(orderId);
    if (order === null) return;

    // The customer-room ETA matters only once the driver is heading to
    // the customer. Pre-pickup, the customer's screen doesn't show ETA
    // at all; post-arrival, the driver is already there.
    if (order.status !== 'en_route_dropoff') return;

    if (order.driverId !== driverId) {
      log.warn(
        { orderId, payloadDriverId: driverId, orderDriverId: order.driverId },
        'eta: ping references order whose driver_id no longer matches — skipping',
      );
      return;
    }

    const dropoff = extractDropoffPoint(order.deliveryAddressSnapshot);
    if (dropoff === null) {
      log.warn(
        { orderId, driverId },
        'eta: order delivery_address_snapshot has no usable location — skipping',
      );
      return;
    }

    let etaResult: Awaited<ReturnType<EtaComputer['computeEta']>>;
    try {
      etaResult = await deps.eta.computeEta({ lat, lng }, dropoff);
    } catch (err) {
      // EtaService already swallows Mapbox/Redis errors and falls back;
      // reaching this catch means a programmer-error path (e.g. invalid
      // coordinates). Log and bail without rethrowing so the geofence
      // observer running in the same fan-out still gets its turn.
      log.warn(
        {
          event: 'eta.compute_failed',
          orderId,
          driverId,
          err: err instanceof Error ? err.message : String(err),
        },
        'eta: computeEta threw unexpectedly — skipping publish',
      );
      return;
    }

    if (!Number.isFinite(etaResult.durationSeconds) || etaResult.durationSeconds <= 0) {
      // Driver is on top of the dropoff. The geofence observer is firing
      // DRIVER_ARRIVED in the same fan-out; publishing a 0-second ETA
      // would fail the customer:eta_updated `positiveNumber` validator
      // anyway. Silent skip — the next ping won't reach here because
      // the status will have moved to `arrived_at_dropoff`.
      return;
    }

    const payload: CustomerEtaUpdatedPayload = {
      orderId,
      customerId: order.userId,
      driverId,
      etaSeconds: etaResult.durationSeconds,
      distanceMeters: etaResult.distanceMeters,
      source: etaResult.source,
      computedAt: clock().toISOString(),
    };

    try {
      await deps.publish({
        id: deps.idGen(),
        emittedAt: clock().toISOString(),
        source: 'workers',
        event: { type: 'customer:eta_updated', payload },
      });
    } catch (err) {
      // Publish failure (Redis outage, XADD rejection) — log and move
      // on. The next ping at ~1Hz will produce another envelope; missing
      // one ETA refresh is far better than failing the whole observer.
      log.warn(
        {
          event: 'eta.publish_failed',
          orderId,
          driverId,
          err: err instanceof Error ? err.message : String(err),
        },
        'eta: publish to realtime stream failed — skipping this refresh',
      );
    }
  };
}
