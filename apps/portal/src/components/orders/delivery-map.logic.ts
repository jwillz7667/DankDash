/**
 * Pure logic for the vendor per-order delivery map. Kept out of the
 * `'use client'` component file so it can be unit-tested without pulling
 * in `react-map-gl` / `maplibre-gl` (which reference WebGL + a CSS import
 * that jsdom can't load).
 */
import { type OrderStatus, type VendorOrderDeliveryGeo } from '../../lib/api/vendor-orders.js';
import { type DriverLocation } from '../../lib/realtime/client.js';

/**
 * Statuses during which a driver is assigned and moving — the window the
 * live map is meaningful. Mirrors the realtime service's
 * `ACTIVE_DELIVERY_STATUSES`: from the moment a driver is assigned
 * through the ID-scan handoff. Before assignment there's no driver to
 * track; once delivered/returned/canceled the run is over.
 */
export const DELIVERY_MAP_STATUSES: readonly OrderStatus[] = [
  'driver_assigned',
  'en_route_pickup',
  'picked_up',
  'en_route_dropoff',
  'arrived_at_dropoff',
  'id_scan_pending',
  'id_scan_passed',
];

const DELIVERY_MAP_STATUS_SET = new Set<OrderStatus>(DELIVERY_MAP_STATUSES);

export function shouldShowDeliveryMap(status: OrderStatus): boolean {
  return DELIVERY_MAP_STATUS_SET.has(status);
}

export interface MapPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * The driver marker position: the live socket location when present,
 * else the SSR snapshot's last-known point, else null (no marker until
 * the first fix). Live always wins so the marker animates the moment a
 * `driver:location` tick lands.
 */
export function resolveDriverPoint(
  live: DriverLocation | null,
  snapshot: VendorOrderDeliveryGeo | undefined,
): MapPoint | null {
  if (live !== null) {
    return { latitude: live.lat, longitude: live.lng };
  }
  return snapshot?.driver ?? null;
}

/**
 * Center + zoom that frames pickup, dropoff, and (if known) the driver.
 * A small fixed zoom keyed off the span keeps the math dependency-free —
 * the map is a glanceable status view, not a routing surface, so a tight
 * fit-to-bounds isn't worth a geo lib.
 */
export function frameViewport(points: readonly MapPoint[]): {
  longitude: number;
  latitude: number;
  zoom: number;
} {
  if (points.length === 0) {
    // Minneapolis fallback — should never render (the map only mounts
    // with at least pickup + dropoff), but keeps the type total.
    return { longitude: -93.265, latitude: 44.9778, zoom: 11 };
  }
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const span = Math.max(maxLat - minLat, maxLng - minLng);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    zoom: zoomForSpan(span),
  };
}

function zoomForSpan(span: number): number {
  if (span <= 0.01) return 14;
  if (span <= 0.05) return 12;
  if (span <= 0.1) return 11;
  if (span <= 0.25) return 10;
  return 9;
}
