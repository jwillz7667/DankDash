/**
 * Delivery geofence rule.
 *
 * The delivery address must fall inside the dispensary's licensed
 * delivery polygon. Production uses PostGIS `ST_Contains` at the
 * repository layer; this rule calls the engine-local ray-casting
 * fallback in `../geo.ts` so it can run DB-free (iOS preview, tests).
 *
 * Interstate addresses (WI, IA, SD, ND, …) fail by virtue of being
 * outside every MN dispensary's polygon — no explicit state-boundary
 * check is required, and adding one would be a false sense of safety
 * (the polygon is the authority).
 */
import { pointInPolygon } from '../geo.js';
import type { EvaluationContext, RuleResult } from '../types.js';

export function checkGeofence(ctx: EvaluationContext): RuleResult {
  const point = ctx.deliveryLocation;
  const inside = pointInPolygon(point, ctx.dispensary.deliveryPolygon);
  return {
    rule: 'delivery_geofence',
    passed: inside,
    details: {
      deliveryLocation: { latitude: point.latitude, longitude: point.longitude },
    },
  };
}
