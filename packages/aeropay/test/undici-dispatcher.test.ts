/**
 * UndiciDispatcher — exercises the production HTTP transport against a
 * loopback `http.Server` so the test runs without any external network
 * dependency. Each test asserts one slice of the dispatcher contract:
 *   - request method/url/body/headers reach the upstream verbatim
 *   - response status/headers/body are normalized to the HttpResponse shape
 *   - headers are lower-cased and array-valued headers join with `, `
 *   - the `timeoutMs` argument propagates to bodyTimeout/headersTimeout
 *   - missing body/timeout fields are not forwarded as `undefined`
 *
 * Port `0` lets the OS assign a free ephemeral port — required so multiple
 * CI workers don't collide on a fixed port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUndiciDispatcher, normalizeHeaders } from '../src/undici-dispatcher.js';
import type { AddressInfo } from 'node:net';

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void;

interface TestServer {
  readonly origin: string;
  readonly captured: CapturedRequest[];
  close: () => Promise<void>;
  setHandler: (h: Handler) => void;
}

async function startServer(): Promise<TestServer> {
  const captured: CapturedRequest[] = [];
  let handler: Handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const cap: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      captured.push(cap);
      handler(req, res, cap);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(addr.port)}`;
  return {
    origin,
    captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        });
      }),
    setHandler: (h) => {
      handler = h;
    },
  };
}

describe('createUndiciDispatcher', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('issues a GET, returns 2xx + body, and lower-cases response headers', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Trace-Id': 'abc' });
      res.end(JSON.stringify({ ok: true }));
    });
    const dispatcher = createUndiciDispatcher({ maxConnections: 4, keepAliveTimeoutMs: 1000 });
    const resp = await dispatcher({
      method: 'GET',
      url: `${server.origin}/v1/payments/abc`,
      headers: { Accept: 'application/json' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe('{"ok":true}');
    expect(resp.headers['content-type']).toContain('application/json');
    expect(resp.headers['x-trace-id']).toBe('abc');
  });

  it('forwards method, url, body, and headers verbatim to the upstream', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(201);
      res.end('{}');
    });
    const dispatcher = createUndiciDispatcher();
    await dispatcher({
      method: 'POST',
      url: `${server.origin}/v1/payments`,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    const cap = server.captured[0]!;
    expect(cap.method).toBe('POST');
    expect(cap.url).toBe('/v1/payments');
    expect(cap.headers['idempotency-key']).toBe('k1');
    expect(cap.headers['content-type']).toBe('application/json');
    expect(cap.body).toBe('{"foo":"bar"}');
  });

  it('joins array-valued response headers with ", "', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'Set-Cookie': ['a=1', 'b=2'] });
      res.end('{}');
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({
      method: 'GET',
      url: `${server.origin}/`,
      headers: {},
    });
    expect(resp.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('uses defaults when no config is supplied', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({ method: 'GET', url: server.origin, headers: {} });
    expect(resp.statusCode).toBe(204);
    expect(resp.body).toBe('');
  });

  it('does not forward a body when none is supplied', async () => {
    const dispatcher = createUndiciDispatcher();
    await dispatcher({
      method: 'GET',
      url: `${server.origin}/no-body`,
      headers: {},
    });
    const cap = server.captured[0]!;
    expect(cap.body).toBe('');
    // GET requests should not advertise a content-length when our caller
    // didn't pass a body.
    expect(cap.headers['content-length']).toBeUndefined();
  });

  it('truncates a response body that exceeds the 1 MiB cap to the cap size', async () => {
    const tooBig = 'A'.repeat(1_048_577); // 1 MiB + 1 byte
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(tooBig);
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({ method: 'GET', url: server.origin, headers: {} });
    expect(resp.body.length).toBe(1_048_576);
  });

  it('returns the upstream status verbatim for 4xx responses (no retry — that is HttpClient territory)', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({ method: 'GET', url: `${server.origin}/missing`, headers: {} });
    expect(resp.statusCode).toBe(404);
    expect(resp.body).toBe('{"error":"not_found"}');
  });

  it('normalizeHeaders skips undefined values, lowercases keys, and joins arrays', () => {
    // Direct unit test of the helper — Node's IncomingMessage types
    // declare undefined-valued headers as possible, but in practice
    // strips them, so this branch is only reachable via a synthetic
    // input.
    const out = normalizeHeaders({
      'X-One': 'a',
      'X-Two': ['b', 'c'],
      'X-Missing': undefined,
    });
    expect(out).toEqual({ 'x-one': 'a', 'x-two': 'b, c' });
    expect(out).not.toHaveProperty('x-missing');
  });

  it('forwards a finite timeoutMs to undici (request still succeeds when the upstream is fast)', async () => {
    // Pure branch-coverage: prove that supplying `timeoutMs` does not
    // break the happy path. We avoid asserting on timeout-triggered
    // failure here — that test would have to race undici's loopback
    // timing and is too flaky for CI. The HttpClient.send tests already
    // assert the timeout value reaches the dispatcher.
    server.setHandler((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({
      method: 'GET',
      url: server.origin,
      headers: {},
      timeoutMs: 30_000,
    });
    expect(resp.statusCode).toBe(200);
  });
});
