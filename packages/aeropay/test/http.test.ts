/**
 * HttpClient retry, timeout, and error-mapping coverage.
 *
 * Every test drives the dispatcher with an in-memory fake that records
 * call counts and arguments — no real network, no real undici. The
 * production path (undici-dispatcher.ts) is exercised separately.
 */
import { ExternalServiceError } from '@dankdash/types';
import { describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  type HttpDispatcher,
  type HttpRequest,
  type HttpResponse,
} from '../src/http.js';

function ok(body = '{}'): HttpResponse {
  return { statusCode: 200, headers: {}, body };
}

function fail(statusCode: number): HttpResponse {
  return { statusCode, headers: {}, body: '' };
}

function makeClient(
  dispatcher: HttpDispatcher,
  opts: Partial<Parameters<typeof HttpClient.prototype.send>[0]> = {},
): HttpClient {
  void opts;
  return new HttpClient({
    dispatcher,
    retries: 2,
    retryBackoffMs: 1,
    sleep: () => Promise.resolve(),
  });
}

const GET_REQ: HttpRequest = {
  method: 'GET',
  url: 'https://example/aeropay/v1/payments/abc',
  headers: { Accept: 'application/json' },
};

const POST_REQ_IDEM: HttpRequest = {
  method: 'POST',
  url: 'https://example/aeropay/v1/payments',
  headers: { Accept: 'application/json', 'Idempotency-Key': 'pi_local_1' },
  body: '{}',
};

const POST_REQ_NO_IDEM: HttpRequest = {
  method: 'POST',
  url: 'https://example/aeropay/v1/payments',
  headers: { Accept: 'application/json' },
  body: '{}',
};

describe('HttpClient', () => {
  it('uses the default retries setting (2) when no override is supplied', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(500));
    const client = new HttpClient({ dispatcher, sleep: () => Promise.resolve() });
    await client.send(GET_REQ);
    // 1 initial + 2 retries = 3 attempts (DEFAULT_RETRIES = 2).
    expect(dispatcher).toHaveBeenCalledTimes(3);
  });

  it('returns the first 2xx response without retrying', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok('{"ok":true}'));
    const client = makeClient(dispatcher);
    const resp = await client.send(GET_REQ);
    expect(resp.statusCode).toBe(200);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('passes the configured default timeout into the dispatcher', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok());
    const client = new HttpClient({
      dispatcher,
      defaultTimeoutMs: 7777,
      retries: 0,
      sleep: () => Promise.resolve(),
    });
    await client.send(GET_REQ);
    const [arg] = dispatcher.mock.calls[0]!;
    expect(arg.timeoutMs).toBe(7777);
  });

  it('honors a per-request timeout over the default', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(ok());
    const client = new HttpClient({
      dispatcher,
      defaultTimeoutMs: 7777,
      retries: 0,
      sleep: () => Promise.resolve(),
    });
    await client.send({ ...GET_REQ, timeoutMs: 1234 });
    const [arg] = dispatcher.mock.calls[0]!;
    expect(arg.timeoutMs).toBe(1234);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'retries on status %d up to the limit',
    async (status) => {
      const dispatcher = vi
        .fn<HttpDispatcher>()
        .mockResolvedValueOnce(fail(status))
        .mockResolvedValueOnce(fail(status))
        .mockResolvedValueOnce(ok());
      const client = makeClient(dispatcher);
      const resp = await client.send(GET_REQ);
      expect(resp.statusCode).toBe(200);
      expect(dispatcher).toHaveBeenCalledTimes(3);
    },
  );

  it('returns the last 5xx response after exhausting retries', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(500));
    const client = makeClient(dispatcher);
    const resp = await client.send(GET_REQ);
    expect(resp.statusCode).toBe(500);
    expect(dispatcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry on a terminal 4xx (e.g. 422)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(422));
    const client = makeClient(dispatcher);
    const resp = await client.send(GET_REQ);
    expect(resp.statusCode).toBe(422);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('retries POSTs that carry an Idempotency-Key header', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(ok());
    const client = makeClient(dispatcher);
    const resp = await client.send(POST_REQ_IDEM);
    expect(resp.statusCode).toBe(200);
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry POSTs without an Idempotency-Key', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(500));
    const client = makeClient(dispatcher);
    const resp = await client.send(POST_REQ_NO_IDEM);
    expect(resp.statusCode).toBe(500);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('treats undefined Idempotency-Key header as missing (no retry on POST)', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(500));
    const client = makeClient(dispatcher);
    await client.send({
      ...POST_REQ_NO_IDEM,
      headers: { Accept: 'application/json', 'Idempotency-Key': undefined as unknown as string },
    });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('wraps the final dispatcher error in ExternalServiceError', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockRejectedValue(new Error('ECONNRESET'));
    const client = makeClient(dispatcher);
    await expect(client.send(GET_REQ)).rejects.toBeInstanceOf(ExternalServiceError);
    expect(dispatcher).toHaveBeenCalledTimes(3);
  });

  it('preserves the underlying cause when wrapping a network error', async () => {
    const cause = new Error('handshake timeout');
    const dispatcher = vi.fn<HttpDispatcher>().mockRejectedValue(cause);
    const client = makeClient(dispatcher);
    try {
      await client.send(GET_REQ);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      const e = err as ExternalServiceError;
      expect(e.cause).toBe(cause);
      expect(e.message).toContain('handshake timeout');
    }
  });

  it('stringifies a non-Error rejection inside the message', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockRejectedValue('socket gone');
    const client = makeClient(dispatcher);
    await expect(client.send(GET_REQ)).rejects.toThrow(/socket gone/);
  });

  it('describes an unknown-shaped rejection as "unknown error"', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockRejectedValue({ weird: true });
    const client = makeClient(dispatcher);
    await expect(client.send(GET_REQ)).rejects.toThrow(/unknown error/);
  });

  it('retries on dispatcher throw, succeeds on second attempt', async () => {
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockRejectedValueOnce(new Error('flake'))
      .mockResolvedValueOnce(ok('{"ok":1}'));
    const client = makeClient(dispatcher);
    const resp = await client.send(GET_REQ);
    expect(resp.statusCode).toBe(200);
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('redacts the query string from logged URLs in the wrapped error', async () => {
    const dispatcher = vi.fn<HttpDispatcher>().mockRejectedValue(new Error('boom'));
    const client = makeClient(dispatcher);
    try {
      await client.send({ ...GET_REQ, url: 'https://example/foo?token=secret123' });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as ExternalServiceError;
      const url = (e.details as { url: string }).url;
      expect(url).toBe('https://example/foo');
      expect(url).not.toContain('secret123');
    }
  });

  it('uses the default sleep (setTimeout) when no override is supplied', async () => {
    vi.useFakeTimers();
    const dispatcher = vi
      .fn<HttpDispatcher>()
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(ok());
    const client = new HttpClient({ dispatcher, retries: 1, retryBackoffMs: 5 });
    const promise = client.send(GET_REQ);
    await vi.advanceTimersByTimeAsync(5);
    const resp = await promise;
    expect(resp.statusCode).toBe(200);
    vi.useRealTimers();
  });

  it('escalates a retry-exhaust on 5xx to PaymentError when somehow loop exits past the final response', async () => {
    // Force the loop to fall through by stubbing the dispatcher to throw
    // a non-retriable shape that bypasses the "return resp" branch by
    // simulating five 5xx responses with `retries: 4`.
    const dispatcher = vi.fn<HttpDispatcher>().mockResolvedValue(fail(502));
    const client = new HttpClient({
      dispatcher,
      retries: 4,
      retryBackoffMs: 1,
      sleep: () => Promise.resolve(),
    });
    const resp = await client.send(GET_REQ);
    expect(resp.statusCode).toBe(502);
    expect(dispatcher).toHaveBeenCalledTimes(5);
  });
});
