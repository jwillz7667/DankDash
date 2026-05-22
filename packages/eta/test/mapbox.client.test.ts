import { ExternalServiceError } from '@dankdash/types';
import { describe, expect, it, vi } from 'vitest';
import { MapboxClient, type FetchLike } from '../src/mapbox.client.js';

const TOKEN = 'pk.test.token';
const FROM = { lat: 44.97798, lng: -93.26528 };
const TO = { lat: 44.98, lng: -93.27 };

function okResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function badResponse(status: number, body: string): Awaited<ReturnType<FetchLike>> {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  };
}

describe('MapboxClient.getDriveTime', () => {
  it('returns duration + distance on a valid 200 response', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve(
        okResponse({
          code: 'Ok',
          routes: [{ duration: 421.7, distance: 3142.2, geometry: null }],
        }),
      ),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    const route = await client.getDriveTime(FROM, TO);

    expect(route).toEqual({ durationSeconds: 421.7, distanceMeters: 3142.2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toContain('/directions/v5/mapbox/driving/');
    // lng,lat;lng,lat — Mapbox / GeoJSON ordering.
    expect(url).toContain('-93.265280,44.977980;-93.270000,44.980000');
    expect(url).toContain(`access_token=${TOKEN}`);
    expect(url).toContain('overview=false');
  });

  it('throws ExternalServiceError on a non-2xx response', async () => {
    const fetchSpy = vi.fn<FetchLike>(() => Promise.resolve(badResponse(429, '{"err":"rate"}')));
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
      message: expect.stringContaining('HTTP 429'),
    });
  });

  it('throws ExternalServiceError when Mapbox returns code != "Ok"', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve(okResponse({ code: 'NoRoute', message: 'no road' })),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(ExternalServiceError);
    await expect(client.getDriveTime(FROM, TO)).rejects.toMatchObject({
      message: expect.stringContaining('NoRoute'),
    });
  });

  it('throws when the body has no routes array', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve(okResponse({ code: 'Ok', routes: [] })),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(/no routes/i);
  });

  it('throws when the first route is missing numeric duration', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve(okResponse({ code: 'Ok', routes: [{ duration: 'soon', distance: 100 }] })),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(/duration/);
  });

  it('throws when the first route is missing numeric distance', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve(okResponse({ code: 'Ok', routes: [{ duration: 100, distance: 'nope' }] })),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(/distance/);
  });

  it('throws when fetch itself throws (network error / abort)', async () => {
    const fetchSpy = vi.fn<FetchLike>(() => Promise.reject(new Error('ECONNRESET')));
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toMatchObject({
      message: expect.stringContaining('Mapbox Directions request failed'),
    });
  });

  it('throws when the response body is malformed JSON', async () => {
    const fetchSpy = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Unexpected token')),
        text: () => Promise.resolve('<html/>'),
      }),
    );
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(/non-JSON/);
  });

  it('throws when the response body is a top-level non-object', async () => {
    const fetchSpy = vi.fn<FetchLike>(() => Promise.resolve(okResponse('just-a-string')));
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime(FROM, TO)).rejects.toThrow(/not an object/);
  });

  it('refuses to construct with an empty access token', () => {
    expect(() => new MapboxClient({ accessToken: '', fetch: vi.fn<FetchLike>() })).toThrow(
      /accessToken/,
    );
  });

  it('refuses to construct when no fetch impl is available', () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    try {
      (globalThis as { fetch?: unknown }).fetch = undefined;
      expect(() => new MapboxClient({ accessToken: TOKEN })).toThrow(/fetch/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it('throws on non-finite coordinates before issuing the request', async () => {
    const fetchSpy = vi.fn<FetchLike>(() => Promise.reject(new Error('should not be called')));
    const client = new MapboxClient({ accessToken: TOKEN, fetch: fetchSpy });

    await expect(client.getDriveTime({ lat: Number.NaN, lng: 0 }, TO)).rejects.toThrow(
      /non-finite/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
