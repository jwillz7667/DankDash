/**
 * Unit tests for GlobalExceptionFilter.
 *
 * Three branches, three contracts:
 *
 *   1. DomainError → declared statusCode + code, increments
 *      `exceptionsTotal{kind="domain"}`, does NOT capture to Sentry
 *      (expected control flow, not a bug).
 *   2. HttpException → preserves status, derives a stable code from the
 *      class name, increments `exceptionsTotal{kind="http"}`, does NOT
 *      capture to Sentry.
 *   3. Anything else → 500 INTERNAL_ERROR with a generic message,
 *      increments `exceptionsTotal{kind="unhandled"}`, AND captures to
 *      Sentry with the request id / path / method tags.
 *
 * The test mounts the filter directly with hand-rolled fakes instead of a
 * full Fastify app so we can introspect every counter increment and
 * Sentry call without round-tripping through HTTP.
 */
import { createExceptionCounters, type SentryHandle } from '@dankdash/observability';
import { ComplianceError, DomainError, type ErrorEnvelope } from '@dankdash/types';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from './global-exception.filter.js';
import type { Logger } from '@dankdash/config';
import type { ArgumentsHost } from '@nestjs/common';

interface RecordedResponse {
  statusCode?: number;
  payload?: ErrorEnvelope;
}

function fakeSentry(): SentryHandle & {
  readonly captured: Array<{ exception: unknown; ctx: Record<string, unknown> }>;
} {
  const captured: Array<{ exception: unknown; ctx: Record<string, unknown> }> = [];
  return {
    initialized: false,
    captureException: (exception: unknown, ctx?: Record<string, unknown>): void => {
      captured.push({ exception, ctx: ctx ?? {} });
    },
    close: () => Promise.resolve(true),
    captured,
  };
}

function fakeLogger(): Logger {
  return {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: () => fakeLogger(),
    level: 'info',
  } as unknown as Logger;
}

function fakeHost(
  url = '/v1/orders',
  method = 'POST',
  requestId: string | undefined = 'req-abc',
): {
  host: ArgumentsHost;
  response: RecordedResponse;
} {
  const response: RecordedResponse = {};
  interface Reply {
    status(code: number): Reply;
    send(body: ErrorEnvelope): Reply;
  }
  const reply: Reply = {
    status: (code: number): Reply => {
      response.statusCode = code;
      return reply;
    },
    send: (body: ErrorEnvelope): Reply => {
      response.payload = body;
      return reply;
    },
  };
  const request = { url, method, requestId };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

async function metricLines(registry: Registry, name: string): Promise<string[]> {
  const text = await registry.metrics();
  return text.split('\n').filter((line) => line.startsWith(name) && !line.startsWith('#'));
}

describe('GlobalExceptionFilter', () => {
  it('renders a DomainError as its declared status + code without paging Sentry', async () => {
    const registry = new Registry();
    const exceptions = createExceptionCounters(registry);
    const sentry = fakeSentry();
    const filter = new GlobalExceptionFilter(fakeLogger(), sentry, exceptions);
    const { host, response } = fakeHost();
    const err = new ComplianceError(
      'COMPLIANCE_LIMIT_EXCEEDED',
      'Cart exceeds 56.7g flower per transaction',
    );

    filter.catch(err, host);

    expect(response.statusCode).toBe(err.statusCode);
    expect(response.payload?.error.code).toBe('COMPLIANCE_LIMIT_EXCEEDED');
    expect(response.payload?.error.request_id).toBe('req-abc');
    expect(sentry.captured).toHaveLength(0);
    const lines = await metricLines(registry, 'http_exceptions_total');
    expect(lines.some((l) => l.includes('kind="domain"') && l.endsWith(' 1'))).toBe(true);
  });

  it('renders a Nest HttpException as its declared status + derived code without paging Sentry', async () => {
    const registry = new Registry();
    const exceptions = createExceptionCounters(registry);
    const sentry = fakeSentry();
    const filter = new GlobalExceptionFilter(fakeLogger(), sentry, exceptions);
    const { host, response } = fakeHost('/v1/orders/missing', 'GET');

    filter.catch(new NotFoundException('order not found'), host);

    expect(response.statusCode).toBe(404);
    expect(response.payload?.error.code).toBe('NOT_FOUND');
    expect(response.payload?.error.message).toBe('order not found');
    expect(sentry.captured).toHaveLength(0);
    const lines = await metricLines(registry, 'http_exceptions_total');
    expect(lines.some((l) => l.includes('kind="http"') && l.endsWith(' 1'))).toBe(true);
  });

  it('captures non-DomainError, non-HttpException throws to Sentry as 500 with a generic message', async () => {
    const registry = new Registry();
    const exceptions = createExceptionCounters(registry);
    const sentry = fakeSentry();
    const filter = new GlobalExceptionFilter(fakeLogger(), sentry, exceptions);
    const { host, response } = fakeHost('/v1/orders', 'POST', 'req-xyz');

    filter.catch(new TypeError('cannot read property foo of undefined'), host);

    expect(response.statusCode).toBe(500);
    expect(response.payload?.error.code).toBe('INTERNAL_ERROR');
    expect(response.payload?.error.message).toBe('An unexpected error occurred');
    expect(response.payload?.error.request_id).toBe('req-xyz');
    expect(sentry.captured).toHaveLength(1);
    expect(sentry.captured[0]?.ctx).toEqual({
      requestId: 'req-xyz',
      path: '/v1/orders',
      method: 'POST',
    });
    const lines = await metricLines(registry, 'http_exceptions_total');
    expect(
      lines.some(
        (l) =>
          l.includes('kind="unhandled"') && l.includes('status_family="5xx"') && l.endsWith(' 1'),
      ),
    ).toBe(true);
  });

  it('coerces non-Error throws to the unhandled branch with a generic message', () => {
    const registry = new Registry();
    const exceptions = createExceptionCounters(registry);
    const sentry = fakeSentry();
    const filter = new GlobalExceptionFilter(fakeLogger(), sentry, exceptions);
    const { host, response } = fakeHost();

    filter.catch('legacy string throw', host);

    expect(response.statusCode).toBe(500);
    expect(response.payload?.error.code).toBe('INTERNAL_ERROR');
    expect(sentry.captured).toHaveLength(1);
    expect(sentry.captured[0]?.exception).toBe('legacy string throw');
  });

  it('keeps counter series independent across kinds + status families', async () => {
    const registry = new Registry();
    const exceptions = createExceptionCounters(registry);
    const filter = new GlobalExceptionFilter(fakeLogger(), fakeSentry(), exceptions);

    class TestDomainError extends DomainError {
      public readonly code = 'TEST_BAD';
      public readonly statusCode = 400;
      constructor() {
        super('bad input');
      }
    }
    filter.catch(new TestDomainError(), fakeHost().host);
    filter.catch(new BadRequestException('bad'), fakeHost().host);
    filter.catch(new NotFoundException('missing'), fakeHost().host);
    filter.catch(new Error('boom'), fakeHost().host);

    const lines = await metricLines(registry, 'http_exceptions_total');
    expect(
      lines.some(
        (l) => l.includes('kind="domain"') && l.includes('status_family="4xx"') && l.endsWith(' 1'),
      ),
    ).toBe(true);
    expect(
      lines.filter((l) => l.includes('kind="http"') && l.includes('status_family="4xx"')).length,
    ).toBe(1);
    expect(
      lines.some(
        (l) => l.includes('kind="http"') && l.includes('status_family="4xx"') && l.endsWith(' 2'),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes('kind="unhandled"') && l.includes('status_family="5xx"') && l.endsWith(' 1'),
      ),
    ).toBe(true);
  });
});
