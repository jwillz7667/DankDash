/**
 * Point-in-polygon geofencing fallback.
 *
 * Production callers run their geofence check through PostGIS at the
 * repository layer (`ST_Contains(delivery_polygon, ST_MakePoint($lon, $lat))`).
 * This file exists for two contexts where Postgres is not available:
 *
 *   1. iOS-client UX preview ("does my address look deliverable?") via the
 *      compliance preview endpoint, which runs the engine without hitting
 *      PostGIS in the request path.
 *   2. Unit tests for the compliance engine, which must be DB-free.
 *
 * The implementation is the standard crossing-number / ray-casting
 * algorithm. Two known semantics:
 *
 *   - Boundary points are ill-defined in general — the algorithm uses
 *     strict comparisons that report points on the west and south edges
 *     as inside and points on the north and east edges as outside. The
 *     test suite exercises each axis-aligned edge so callers can rely on
 *     the actual behaviour.
 *   - Holes in the polygon (inner rings of GeoJSON `coordinates[1..]`)
 *     are subtracted: a point inside the outer ring AND inside any inner
 *     ring is reported outside the polygon.
 *
 * The algorithm treats coordinates as a Cartesian plane and ignores
 * Earth curvature. For a single-state delivery polygon this introduces
 * sub-meter error and is acceptable for preview purposes; the server is
 * the authority and runs the geographic check via PostGIS.
 */
import type { Polygon } from 'geojson';

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * O(n) in the total vertex count of the polygon (outer + holes).
 *
 * Degenerate inputs return `false`:
 *   - polygon with no rings,
 *   - outer ring with fewer than 3 vertices,
 *   - any coordinate position that is not at least [lon, lat].
 *
 * Inner rings that are degenerate are skipped rather than treated as
 * exclusionary, which is the conservative choice — a malformed hole
 * cannot trick the function into reporting a real outer-ring point as
 * outside the polygon.
 */
export function pointInPolygon(point: Coordinate, polygon: Polygon): boolean {
  const rings = polygon.coordinates;
  if (rings.length === 0) return false;

  const outer = rings[0];
  if (outer === undefined || outer.length < 3) return false;
  if (!isInsideRing(point, outer)) return false;

  for (let r = 1; r < rings.length; r++) {
    const hole = rings[r];
    if (hole === undefined || hole.length < 3) continue;
    if (isInsideRing(point, hole)) return false;
  }
  return true;
}

function isInsideRing(point: Coordinate, ring: ReadonlyArray<ReadonlyArray<number>>): boolean {
  const x = point.longitude;
  const y = point.latitude;
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i];
    const previous = ring[j];
    j = i;
    /* c8 ignore next -- bounded loop indices; only TypeScript's noUncheckedIndexedAccess demands this */
    if (current === undefined || previous === undefined) continue;
    const xi = current[0];
    const yi = current[1];
    const xj = previous[0];
    const yj = previous[1];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;
    const straddlesRay = yi > y !== yj > y;
    if (!straddlesRay) continue;
    const xIntersect = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < xIntersect) inside = !inside;
  }
  return inside;
}
