'use client';

/**
 * Vendor per-order live delivery map. Paints the pickup (dispensary),
 * the drop-off, and a moving driver marker, animating the driver off the
 * `driver:location` realtime stream (filtered to this order). Renders
 * only while the order is in a live-delivery status; before assignment /
 * after completion it shows a short placeholder instead of an empty map.
 *
 * The driver point prefers the live socket tick and falls back to the
 * server snapshot (`delivery.driver`) so the marker is present on first
 * paint when the driver already has a fix. MapLibre + the free OpenFreeMap
 * style — no token, no per-render network beyond tiles.
 */
import { House, Navigation, Store } from 'lucide-react';
import { type ReactNode } from 'react';
import Map, { Marker } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type OrderStatus, type VendorOrderDeliveryGeo } from '../../lib/api/vendor-orders.js';
import { useDriverLocation } from '../../lib/realtime/hooks.js';
import { Card, CardBody } from '../ui/card.js';
import {
  frameViewport,
  resolveDriverPoint,
  shouldShowDeliveryMap,
  type MapPoint,
} from './delivery-map.logic.js';

const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export interface DeliveryMapProps {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly delivery: VendorOrderDeliveryGeo | undefined;
  readonly realtime: {
    readonly url: string;
    readonly token: string;
    readonly dispensaryId?: string;
  };
}

export function DeliveryMap({ orderId, status, delivery, realtime }: DeliveryMapProps): ReactNode {
  const isLive = shouldShowDeliveryMap(status);

  // Subscribe only while live — the hook no-ops when disabled, so a
  // delivered/pre-assignment order never opens a socket.
  const { status: connection, location } = useDriverLocation({
    url: realtime.url,
    token: realtime.token,
    ...(realtime.dispensaryId !== undefined ? { dispensaryId: realtime.dispensaryId } : {}),
    orderId,
    enabled: isLive,
  });

  if (!isLive || delivery === undefined) {
    return <DeliveryMapPlaceholder isLive={isLive} hasGeometry={delivery !== undefined} />;
  }

  const pickup: MapPoint = delivery.pickup;
  const dropoff: MapPoint = delivery.dropoff;
  const driver = resolveDriverPoint(location, delivery);
  const viewport = frameViewport([pickup, dropoff, ...(driver !== null ? [driver] : [])]);

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Live delivery</h2>
          <LiveBadge connected={connection === 'connected'} hasFix={driver !== null} />
        </div>
        <div
          className="h-[360px] w-full overflow-hidden rounded-xl border border-outline"
          data-testid="delivery-map-canvas"
        >
          <Map
            initialViewState={{
              longitude: viewport.longitude,
              latitude: viewport.latitude,
              zoom: viewport.zoom,
            }}
            mapStyle={MAP_STYLE_URL}
            style={{ width: '100%', height: '100%' }}
            attributionControl={{ compact: true }}
          >
            <Marker longitude={pickup.longitude} latitude={pickup.latitude} anchor="bottom">
              <MapPin tone="pickup" label="Pickup">
                <Store aria-hidden="true" className="h-3.5 w-3.5" />
              </MapPin>
            </Marker>
            <Marker longitude={dropoff.longitude} latitude={dropoff.latitude} anchor="bottom">
              <MapPin tone="dropoff" label="Drop-off">
                <House aria-hidden="true" className="h-3.5 w-3.5" />
              </MapPin>
            </Marker>
            {driver !== null && (
              <Marker longitude={driver.longitude} latitude={driver.latitude} anchor="center">
                <MapPin tone="driver" label="Driver">
                  <Navigation aria-hidden="true" className="h-3.5 w-3.5" />
                </MapPin>
              </Marker>
            )}
          </Map>
        </div>
      </CardBody>
    </Card>
  );
}

function MapPin({
  tone,
  label,
  children,
}: {
  readonly tone: 'pickup' | 'dropoff' | 'driver';
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  // Mirrors the iOS LiveMapView tints: pickup = brand, drop-off =
  // success-green, driver = amber/attention.
  const toneClass =
    tone === 'pickup' ? 'bg-moss-600' : tone === 'dropoff' ? 'bg-success' : 'bg-warning';
  return (
    <span
      className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface text-white shadow-md ${toneClass}`}
      aria-label={label}
      title={label}
    >
      {children}
    </span>
  );
}

function LiveBadge({
  connected,
  hasFix,
}: {
  readonly connected: boolean;
  readonly hasFix: boolean;
}): ReactNode {
  const label = !connected ? 'Connecting…' : hasFix ? 'Live' : 'Waiting for driver';
  const dotClass = connected ? 'bg-success' : 'bg-muted';
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
      <span className={`h-2 w-2 rounded-full ${dotClass} ${connected ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}

function DeliveryMapPlaceholder({
  isLive,
  hasGeometry,
}: {
  readonly isLive: boolean;
  readonly hasGeometry: boolean;
}): ReactNode {
  const message = !isLive
    ? 'Live tracking appears once a driver is on the way.'
    : hasGeometry
      ? 'Live tracking appears once a driver is on the way.'
      : 'Delivery location is unavailable for this order.';
  return (
    <Card>
      <CardBody className="flex h-[160px] items-center justify-center text-center">
        <p className="max-w-sm text-sm text-muted">{message}</p>
      </CardBody>
    </Card>
  );
}
