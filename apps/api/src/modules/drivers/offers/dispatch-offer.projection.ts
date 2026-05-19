/**
 * `dispatch_offers` row → `DispatchOfferResponse` projection.
 *
 * Single source of truth for offer serialisation. DB row carries `Date`
 * for the offered/expires/responded timestamps; wire format carries
 * ISO-8601 strings so a JS client `new Date(s)` round-trips losslessly.
 * `distance_miles` arrives from pg as a NUMERIC string — kept as-is at
 * the wire (no Number coercion) so the displayed mileage matches what
 * was scored at offer-creation time.
 */
import { type DispatchOffer } from '@dankdash/db';
import { type DispatchOfferResponse } from './dto/index.js';

export function projectDispatchOffer(row: DispatchOffer): DispatchOfferResponse {
  return {
    id: row.id,
    orderId: row.orderId,
    driverId: row.driverId,
    offeredAt: row.offeredAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    payoutEstimateCents: row.payoutEstimateCents,
    distanceMiles: row.distanceMiles,
    status: row.status,
    respondedAt: row.respondedAt === null ? null : row.respondedAt.toISOString(),
    declineReason: row.declineReason,
  };
}
