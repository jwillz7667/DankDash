/**
 * UndiciDispatcher — exercises the production HTTP transport against a
 * loopback `http.Server` so the test runs without any external network
 * dependency. Mirrors the aeropay package's approach.
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
    res.end('[]');
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
      res.end('[]');
    });
    const dispatcher = createUndiciDispatcher({ maxConnections: 4, keepAliveTimeoutMs: 1000 });
    const resp = await dispatcher({
      method: 'GET',
      url: `${server.origin}/sales/v2/receipts/active?licenseNumber=ABC`,
      headers: { Accept: 'application/json' },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe('[]');
    expect(resp.headers['content-type']).toContain('application/json');
    expect(resp.headers['x-trace-id']).toBe('abc');
  });

  it('forwards method, url, body, and headers verbatim to the upstream', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const dispatcher = createUndiciDispatcher();
    await dispatcher({
      method: 'POST',
      url: `${server.origin}/sales/v2/receipts?licenseNumber=ABC`,
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic dXNlcjpwYXNz' },
      body: '[{"SalesDateTime":"2026-05-19T14:55:00.000Z"}]',
    });
    const cap = server.captured[0]!;
    expect(cap.method).toBe('POST');
    expect(cap.url).toBe('/sales/v2/receipts?licenseNumber=ABC');
    expect(cap.headers.authorization).toBe('Basic dXNlcjpwYXNz');
    expect(cap.headers['content-type']).toBe('application/json');
    expect(cap.body).toBe('[{"SalesDateTime":"2026-05-19T14:55:00.000Z"}]');
  });

  it('joins array-valued response headers with ", "', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'Set-Cookie': ['a=1', 'b=2'] });
      res.end('[]');
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({ method: 'GET', url: `${server.origin}/`, headers: {} });
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
    expect(cap.headers['content-length']).toBeUndefined();
  });

  it('truncates a response body that exceeds the 1 MiB cap to the cap size', async () => {
    const tooBig = 'A'.repeat(1_048_577);
    server.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(tooBig);
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({ method: 'GET', url: server.origin, headers: {} });
    expect(resp.body.length).toBe(1_048_576);
  });

  it('returns 401 verbatim (HttpClient owns retry, not the dispatcher)', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"Error":"Unauthorized"}');
    });
    const dispatcher = createUndiciDispatcher();
    const resp = await dispatcher({
      method: 'GET',
      url: `${server.origin}/sales/v2/receipts/active?licenseNumber=NOPE`,
      headers: { Authorization: 'Basic wrong' },
    });
    expect(resp.statusCode).toBe(401);
    expect(resp.body).toBe('{"Error":"Unauthorized"}');
  });

  it('forwards a finite timeoutMs to undici (request still succeeds when fast)', async () => {
    server.setHandler((_req, res) => {
      res.writeHead(200);
      res.end();
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

describe('normalizeHeaders', () => {
  it('lowercases keys and forwards string values verbatim', () => {
    expect(normalizeHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'content-type': 'application/json',
    });
  });

  it('joins multi-value array headers with ", "', () => {
    expect(normalizeHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({
      'set-cookie': 'a=1, b=2',
    });
  });

  it('drops undefined values', () => {
    expect(normalizeHeaders({ 'x-keep': 'yes', 'x-drop': undefined })).toEqual({ 'x-keep': 'yes' });
  });

  it('returns an empty object for an empty input', () => {
    expect(normalizeHeaders({})).toEqual({});
  });
});
