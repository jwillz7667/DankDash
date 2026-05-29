/**
 * GlobalExceptionFilter unit tests.
 *
 * The filter is the single boundary that turns thrown errors into the
 * standard ErrorEnvelope. These tests pin the three dispatch branches
 * (DomainError, HttpException, unknown) and the 429 Retry-After header
 * derived from RateLimitGuard's `retryAfterMs`.
 */
import { RateLimitError, ValidationError } from '@dankdash/types';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { GlobalExceptionFilter } from './global-exception.filter.js';
import type { Logger } from '@dankdash/config';
import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

class FakeReply {
  statusCode: number | null = null;
  body: unknown = null;
  headers: Record<string, string> = {};

  status = (code: number): this => {
    this.statusCode = code;
    return this;
  };

  send = (body: unknown): this => {
    this.body = body;
    return this;
  };

  header = (name: string, value: string): this => {
    this.headers[name] = value;
    return this;
  };
}

// Records nothing — the filter logs once per error and the assertions only
// care about the response, so a no-op sink keeps the tests focused.
const noop = (): void => {
  // intentionally empty: the structured log line is not under test here
};
const noopLogger = { warn: noop, error: noop } as unknown as Logger;

function build(): { filter: GlobalExceptionFilter; reply: FakeReply; host: ArgumentsHost } {
  const reply = new FakeReply();
  const req = {
    url: '/v1/auth/login',
    method: 'POST',
    requestId: 'req_1',
  } as unknown as FastifyRequest;
  const httpHost = {
    getRequest: () => req,
    getResponse: () => reply as unknown as FastifyReply,
  };
  const host = { switchToHttp: () => httpHost } as unknown as ArgumentsHost;
  return { filter: new GlobalExceptionFilter(noopLogger), reply, host };
}

describe('GlobalExceptionFilter', () => {
  it('maps a RateLimitError to 429 with a rounded-up Retry-After header', () => {
    const { filter, reply, host } = build();

    filter.catch(new RateLimitError('rate limit exceeded', { retryAfterMs: 1500 }), host);

    expect(reply.statusCode).toBe(429);
    expect(reply.headers['Retry-After']).toBe('2');
    expect((reply.body as { error: { code: string } }).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('floors Retry-After at 1 second for sub-second windows', () => {
    const { filter, reply, host } = build();

    filter.catch(new RateLimitError('slow down', { retryAfterMs: 200 }), host);

    expect(reply.statusCode).toBe(429);
    expect(reply.headers['Retry-After']).toBe('1');
  });

  it('omits Retry-After when the rate-limit error carries no retryAfterMs', () => {
    const { filter, reply, host } = build();

    filter.catch(new RateLimitError('rate limit exceeded'), host);

    expect(reply.statusCode).toBe(429);
    expect(reply.headers['Retry-After']).toBeUndefined();
  });

  it('maps a generic DomainError to its statusCode + code without a Retry-After', () => {
    const { filter, reply, host } = build();

    filter.catch(new ValidationError('bad input', { field: 'email' }), host);

    expect(reply.statusCode).toBe(422);
    expect((reply.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(reply.headers['Retry-After']).toBeUndefined();
  });

  it('preserves an HttpException status and derives a stable code from the class name', () => {
    const { filter, reply, host } = build();

    filter.catch(new BadRequestException('nope'), host);

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('maps an unknown throw to 500 INTERNAL_ERROR without leaking the message', () => {
    const { filter, reply, host } = build();

    filter.catch(new Error('postgres connection string leaked here'), host);

    expect(reply.statusCode).toBe(500);
    const body = reply.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred');
  });
});
