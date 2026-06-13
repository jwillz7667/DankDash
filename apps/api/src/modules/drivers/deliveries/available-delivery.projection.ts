/**
 * `AvailableDeliveryRow` (DB) → `AvailableDelivery` (wire) projection.
 *
 * Single source of truth for open-pool delivery serialisation. The repo
 * returns the pickup/dropoff coordinates as flat lat/lng numbers and the
 * `awaitingDriverAt` as a `Date`; the wire shape nests the coordinates
 * under `pickup`/`dropoff` (so the iOS client decodes a `Coordinate`
 * value type directly) and renders the timestamp as an ISO-8601 string.
 */
import { type AvailableDeliveryRow } from '@dankdash/db';
import { type AvailableDelivery } from './dto/index.js';

export function projectAvailableDelivery(row: AvailableDeliveryRow): AvailableDelivery {
  return {
    orderId: row.orderId,
    shortCode: row.shortCode,
    dispensaryId: row.dispensaryId,
    pickupName: row.pickupName,
    pickup: { lat: row.pickupLat, lng: row.pickupLng },
    dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
    tipCents: row.tipCents,
    totalCents: row.totalCents,
    distanceMeters: row.distanceMeters,
    awaitingDriverAt: row.awaitingDriverAt === null ? null : row.awaitingDriverAt.toISOString(),
  };
}
