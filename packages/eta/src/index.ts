/**
 * `@dankdash/eta` public surface.
 *
 * Everything in this package is dependency-injectable — the EtaService
 * takes its Redis client and MapboxClient at construction, and the
 * MapboxClient takes its fetch impl. That keeps the package framework-
 * neutral so the API, workers, and a future Next.js consumer route can
 * all share it without dragging in transitive runtime baggage.
 */
export {
  DEFAULT_GRID_PRECISION_DEGREES,
  gridPairCacheKey,
  quantizeToGrid,
  type GridCell,
} from './grid.js';
export { haversineMeters, type LatLng } from './distance.js';
export {
  MapboxClient,
  type MapboxClientOptions,
  type DirectionsRoute,
  type FetchLike,
} from './mapbox.client.js';
export {
  EtaService,
  type EtaResult,
  type EtaServiceOptions,
  type EtaSource,
  type EtaLogger,
} from './eta.service.js';
