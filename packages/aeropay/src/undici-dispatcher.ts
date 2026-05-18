/**
 * Production HTTP dispatcher backed by undici.
 *
 * Kept in a separate module from {@link HttpClient} so the test suite can
 * exercise the client logic without bringing undici into the fixture
 * surface and the production code path doesn't need to mock module
 * imports. The dispatcher closes over a long-lived `Agent` so connection
 * keep-alive amortizes across requests — Aeropay's API is hosted on a
 * single TLS endpoint and recreating the TCP connection on every call
 * would dominate latency.
 */
import { Agent, request as undiciRequest } from 'undici';
import { type HttpDispatcher, type HttpRequest, type HttpResponse } from './http.js';

export interface UndiciDispatcherConfig {
  readonly maxConnections?: number;
  readonly keepAliveTimeoutMs?: number;
}

const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_KEEP_ALIVE_MS = 60_000;
const MAX_BODY_BYTES = 1_048_576; // 1 MiB — every Aeropay response is JSON well under this.

export function createUndiciDispatcher(config: UndiciDispatcherConfig = {}): HttpDispatcher {
  const agent = new Agent({
    connections: config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    keepAliveTimeout: config.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_MS,
  });

  return async (req: HttpRequest): Promise<HttpResponse> => {
    const options: Parameters<typeof undiciRequest>[1] = {
      method: req.method,
      headers: { ...req.headers },
      dispatcher: agent,
    };
    if (req.body !== undefined) {
      options.body = req.body;
    }
    if (req.timeoutMs !== undefined) {
      options.bodyTimeout = req.timeoutMs;
      options.headersTimeout = req.timeoutMs;
    }
    const { statusCode, headers, body } = await undiciRequest(req.url, options);

    const text = await readBodyBounded(body, MAX_BODY_BYTES);

    return {
      statusCode,
      headers: normalizeHeaders(headers),
      body: text,
    };
  };
}

async function readBodyBounded(
  body: { text: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  const text = await body.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return text.slice(0, maxBytes);
  }
  return text;
}

/**
 * Exported for unit testing — Node's `IncomingMessage.headers` declares
 * `string | string[] | undefined` but in practice strips undefined
 * values before delivery, so the defensive branch can only be exercised
 * via a synthetic input.
 */
export function normalizeHeaders(
  raw: Record<string, string | string[] | undefined>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
