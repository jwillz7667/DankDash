/**
 * Thin typed wrapper over the Mapbox Directions v5 API (driving profile).
 *
 * Why hand-roll instead of using `@mapbox/mapbox-sdk`:
 *   - The official SDK ships a Promise-or-callback dual API, a generic
 *     "MapiRequest" abstraction over fetch, and a 100-kB dependency
 *     surface. We need exactly one endpoint with a flat (lng,lat) →
 *     (durationSeconds, distanceMeters) shape; the SDK is dead weight.
 *   - We want the `fetch` impl injectable (Node 22 native fetch in
 *     production, a Vitest fake in tests). Injecting through the SDK
 *     is awkward; pulling our own is two screens of code.
 *
 * Failure model: every non-2xx HTTP, malformed body, and Mapbox-side
 * "NoRoute"/"NoSegment" response throws `ExternalServiceError`. The
 * EtaService wraps the call in a try/catch and falls back to haversine
 * — the throw lets the service treat all failure modes uniformly without
 * duplicating "is this a fallback case" logic per error type.
 *
 * No retries here. Retries belong at the EtaService layer (where we own
 * the timeout + fallback budget) and not in the transport layer (where a
 * retry would silently double the latency budget without the caller
 * knowing).
 */
import { ExternalServiceError } from '@dankdash/types';
import type { LatLng } from './distance.js';

/**
 * Subset of `globalThis.fetch` we actually use. Typing it ourselves
 * means tests can hand in a vi.fn() without dragging in a full
 * `typeof fetch` (which carries DOM lib types).
 */
export type FetchLike = (
  input: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

export interface MapboxClientOptions {
  readonly accessToken: string;
  /** Override base URL — defaults to public Mapbox endpoint. Useful for tests. */
  readonly baseUrl?: string;
  /** Injectable fetch — defaults to globalThis.fetch. */
  readonly fetch?: FetchLike;
  /** Per-request timeout (ms). Defaults to 2_000 — Mapbox typically responds in <300 ms. */
  readonly timeoutMs?: number;
}

export interface DirectionsRoute {
  /** End-to-end driving duration in seconds (Mapbox traffic-unaware "driving" profile). */
  readonly durationSeconds: number;
  /** Route distance in metres. */
  readonly distanceMeters: number;
}

const DEFAULT_BASE_URL = 'https://api.mapbox.com';
const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Mapbox Directions client. One instance per process — `fetch` and the
 * abort controller are stateless, so concurrent calls are safe.
 */
export class MapboxClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: MapboxClientOptions) {
    if (options.accessToken.length === 0) {
      throw new ExternalServiceError('mapbox', 'MapboxClient: accessToken must be non-empty');
    }
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    // Node 22+ ships native fetch. The cast is a contract assertion; the
    // FetchLike subset is intentionally narrower than the global typedef
    // so we are not coupled to DOM lib types in this package.
    const defaultFetch = globalThis.fetch as unknown as FetchLike | undefined;
    const chosen = options.fetch ?? defaultFetch;
    if (chosen === undefined) {
      throw new ExternalServiceError('mapbox', 'MapboxClient: no fetch impl available');
    }
    this.fetch = chosen;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Returns the first route's duration + distance. Throws on any failure
   * (HTTP error, malformed body, NoRoute). The EtaService layer treats
   * every throw as a fallback signal.
   */
  async getDriveTime(from: LatLng, to: LatLng): Promise<DirectionsRoute> {
    const coords = `${encodeCoord(from.lng)},${encodeCoord(from.lat)};${encodeCoord(to.lng)},${encodeCoord(to.lat)}`;
    const url = `${this.baseUrl}/directions/v5/mapbox/driving/${coords}?access_token=${encodeURIComponent(this.accessToken)}&overview=false&geometries=geojson`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetch(url, { signal: controller.signal });
    } catch (err) {
      throw new ExternalServiceError('mapbox', 'Mapbox Directions request failed', {}, err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 401/403 (token), 429 (rate), 5xx (mapbox outage) all surface here.
      // Body text helps debugging; we cap implicitly via Mapbox's small
      // error payloads.
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '<unreadable>';
      }
      throw new ExternalServiceError(
        'mapbox',
        `Mapbox Directions returned HTTP ${response.status.toString()}`,
        { status: response.status, body },
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      throw new ExternalServiceError('mapbox', 'Mapbox Directions returned non-JSON body', {}, err);
    }

    return parseDirectionsResponse(raw);
  }
}

/**
 * Mapbox sends coordinates with up to 6 decimal places (~11 cm) — we
 * never need more than that, and trimming keeps URLs short enough that
 * the GET stays well under any CDN URL-length limit.
 */
function encodeCoord(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ExternalServiceError('mapbox', `non-finite coordinate ${String(value)}`);
  }
  return value.toFixed(6);
}

/**
 * Parse the Directions v5 response into `DirectionsRoute`. Validates
 * just enough structure to surface a "Mapbox replied 200 but we cannot
 * use it" condition as a typed throw rather than a downstream TypeError.
 */
function parseDirectionsResponse(raw: unknown): DirectionsRoute {
  if (raw === null || typeof raw !== 'object') {
    throw new ExternalServiceError('mapbox', 'Mapbox response body is not an object');
  }
  const body = raw as Record<string, unknown>;
  const code = body.code;
  if (code !== 'Ok') {
    // "NoRoute", "NoSegment", "ProfileNotFound", etc. — caller falls back.
    throw new ExternalServiceError('mapbox', `Mapbox response code=${String(code)}`, {
      mapboxCode: typeof code === 'string' ? code : null,
      message: typeof body.message === 'string' ? body.message : null,
    });
  }
  const routes = body.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new ExternalServiceError('mapbox', 'Mapbox response has no routes');
  }
  const first: unknown = routes[0];
  if (first === null || typeof first !== 'object') {
    throw new ExternalServiceError('mapbox', 'Mapbox route entry is not an object');
  }
  const route = first as Record<string, unknown>;
  const durationSeconds = route.duration;
  const distanceMeters = route.distance;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    throw new ExternalServiceError('mapbox', 'Mapbox route missing numeric duration');
  }
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
    throw new ExternalServiceError('mapbox', 'Mapbox route missing numeric distance');
  }
  return { durationSeconds, distanceMeters };
}
