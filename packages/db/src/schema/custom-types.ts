import { customType } from 'drizzle-orm/pg-core';

/**
 * GeoJSON Point geometry (lng/lat, WGS84).
 * `coordinates` is `[longitude, latitude]` per RFC 7946.
 */
export interface GeoPoint {
  readonly type: 'Point';
  readonly coordinates: readonly [number, number];
}

/**
 * GeoJSON Polygon geometry (WGS84). The first ring is the outer boundary;
 * subsequent rings (if any) are holes. Each ring is an array of
 * `[longitude, latitude]` coordinate pairs and must close (first == last).
 */
export interface GeoPolygon {
  readonly type: 'Polygon';
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

/**
 * `geography(POINT, 4326)` column.
 *
 * Reads return GeoJSON via the `ST_AsGeoJSON` cast injected by the
 * repositories — Drizzle does not parse PostGIS WKB natively. The raw column
 * payload is therefore typed as `string` at the driver boundary and parsed by
 * helpers in {@link encodePoint} / {@link decodeGeoJSON}.
 *
 * For writes we accept a `GeoPoint` and emit an `ST_GeogFromText` literal
 * via the SQL helpers in `geo.ts`.
 */
export const geographyPoint = customType<{
  data: string;
  driverData: string;
  notNull: false;
  default: false;
}>({
  dataType() {
    return 'geography(Point,4326)';
  },
});

/**
 * `geography(POLYGON, 4326)` column. See {@link geographyPoint}.
 */
export const geographyPolygon = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'geography(Polygon,4326)';
  },
});

/**
 * `bytea` column for opaque binary payloads — hashes, encrypted blobs.
 * Reads/writes use `Uint8Array`; the postgres driver returns `Buffer`
 * which is a Node `Uint8Array` subclass.
 */
export const bytea = customType<{
  data: Uint8Array;
  driverData: Buffer;
}>({
  dataType() {
    return 'bytea';
  },
  toDriver(value): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value): Uint8Array {
    return new Uint8Array(value);
  },
});

/**
 * `citext` column — case-insensitive text. Postgres treats values as text
 * but compares case-insensitively. Used for email columns.
 */
export const citext = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'citext';
  },
});

/**
 * `inet` column for client IPs. Stored verbatim; comparison and CIDR
 * matching happen in SQL when needed.
 */
export const inet = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'inet';
  },
});

/**
 * `tsvector` column — populated by the `products_search_vector_update` trigger.
 * Application code never writes this directly; reads are normally projected
 * away from list/detail responses.
 */
export const tsvector = customType<{
  data: string;
  driverData: string;
  notNull: false;
  default: false;
}>({
  dataType() {
    return 'tsvector';
  },
});
