import { sql, type SQL } from 'drizzle-orm';
import type { GeoPoint, GeoPolygon } from './custom-types.js';

/**
 * Build an `ST_GeogFromText('SRID=4326;POINT(lng lat)')` SQL expression
 * for inserting/updating a `geography(POINT, 4326)` column from a `GeoPoint`.
 *
 * Coordinates follow GeoJSON convention: `[longitude, latitude]`. This is the
 * opposite of "lat,lng" seen in many maps APIs — be careful.
 */
export function pointToSql(point: GeoPoint): SQL {
  const [lng, lat] = point.coordinates;
  return sql`ST_GeogFromText(${`SRID=4326;POINT(${lng.toString()} ${lat.toString()})`})`;
}

/**
 * Build an `ST_GeogFromText('SRID=4326;POLYGON(...)')` SQL expression for a
 * `geography(POLYGON, 4326)` column. The polygon must close (first coordinate
 * pair equals last) — PostGIS rejects open rings.
 */
export function polygonToSql(polygon: GeoPolygon): SQL {
  const rings = polygon.coordinates
    .map((ring) => {
      const pairs = ring.map(([lng, lat]) => `${lng.toString()} ${lat.toString()}`).join(',');
      return `(${pairs})`;
    })
    .join(',');
  return sql`ST_GeogFromText(${`SRID=4326;POLYGON(${rings})`})`;
}

/**
 * Project a `geography` column to GeoJSON for reads. Returns SQL that yields
 * a JSON string; callers parse via {@link parseGeoJSONString}.
 */
export function pointToGeoJSON(column: SQL): SQL {
  return sql`ST_AsGeoJSON(${column})`;
}

/**
 * Parse a `ST_AsGeoJSON` payload back to a typed {@link GeoPoint}.
 * Throws if the value is not a valid GeoJSON Point.
 */
export function parsePoint(value: string): GeoPoint {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'type' in parsed &&
    parsed.type === 'Point' &&
    'coordinates' in parsed &&
    Array.isArray(parsed.coordinates) &&
    parsed.coordinates.length === 2 &&
    typeof parsed.coordinates[0] === 'number' &&
    typeof parsed.coordinates[1] === 'number'
  ) {
    return {
      type: 'Point',
      coordinates: [parsed.coordinates[0], parsed.coordinates[1]],
    };
  }
  throw new TypeError(`Invalid GeoJSON Point: ${value}`);
}

/**
 * Parse a `ST_AsGeoJSON` payload back to a typed {@link GeoPolygon}.
 * Throws if the value is not a valid GeoJSON Polygon.
 */
export function parsePolygon(value: string): GeoPolygon {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'type' in parsed &&
    parsed.type === 'Polygon' &&
    'coordinates' in parsed &&
    Array.isArray(parsed.coordinates)
  ) {
    const rings = parsed.coordinates.map((ring) => {
      if (!Array.isArray(ring)) {
        throw new TypeError(`Invalid GeoJSON Polygon ring: ${value}`);
      }
      return ring.map((coord) => {
        if (
          !Array.isArray(coord) ||
          coord.length !== 2 ||
          typeof coord[0] !== 'number' ||
          typeof coord[1] !== 'number'
        ) {
          throw new TypeError(`Invalid GeoJSON Polygon coordinate: ${JSON.stringify(coord)}`);
        }
        return [coord[0], coord[1]] as const;
      });
    });
    return { type: 'Polygon', coordinates: rings };
  }
  throw new TypeError(`Invalid GeoJSON Polygon: ${value}`);
}
