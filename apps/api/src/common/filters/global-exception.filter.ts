/**
 * Global exception filter — converts thrown errors into the standard
 * `ErrorEnvelope` shape from `openapi-excerpt.yaml`.
 *
 *   - {@link DomainError} subclasses → use their declared statusCode + code.
 *   - NestJS HttpException → preserve status; derive a stable code from the
 *     class name (`BadRequestException` -> `BAD_REQUEST`).
 *   - Anything else (including non-Error throws) → 500 INTERNAL_ERROR with
 *     no leak of the underlying message to the client.
 *
 * Every branch increments `http_exceptions_total{kind,status_family}` so
 * the metric series can drive both the dashboard breakdown (domain vs
 * http vs unhandled) and the on-call alert (`unhandled` > 0 pages). The
 * `unhandled` branch is the only one that forwards to Sentry — DomainError
 * and HttpException are *expected* application control flow, not bugs,
 * and Sentry should not page on them.
 *
 * All errors are logged once at the boundary with the request id. The
 * inbound logger (LoggingInterceptor) does NOT log errors itself to avoid
 * double-counting.
 */
import { type Logger } from '@dankdash/config';
import { statusFamily, type ExceptionCounters, type SentryHandle } from '@dankdash/observability';
import { DomainError, toErrorEnvelope } from '@dankdash/types';
import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';

interface RequestWithId extends FastifyRequest {
  readonly requestId?: string;
}

function classNameToCode(name: string): string {
  return name
    .replace(/Exception$/u, '')
    .replace(/([a-z])([A-Z])/gu, '$1_$2')
    .toUpperCase();
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly sentry: SentryHandle,
    private readonly exceptions: ExceptionCounters,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<FastifyReply>();
    const requestId = req.requestId;

    if (exception instanceof DomainError) {
      this.exceptions.exceptionsTotal.inc({
        kind: 'domain',
        status_family: statusFamily(exception.statusCode),
      });
      this.logger.warn(
        {
          err: exception,
          code: exception.code,
          requestId,
          path: req.url,
          method: req.method,
        },
        'request failed with domain error',
      );
      void res.status(exception.statusCode).send(toErrorEnvelope(exception, requestId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const message =
        typeof responseBody === 'string'
          ? responseBody
          : (((responseBody as { message?: unknown }).message as string | undefined) ??
            exception.message);
      const code = classNameToCode(exception.constructor.name) || 'HTTP_ERROR';
      this.exceptions.exceptionsTotal.inc({
        kind: 'http',
        status_family: statusFamily(status),
      });
      this.logger.warn(
        { err: exception, requestId, path: req.url, method: req.method, status },
        'request failed with http exception',
      );
      void res.status(status).send({
        error: {
          code,
          message,
          details: {},
          ...(requestId !== undefined ? { request_id: requestId } : {}),
        },
      });
      return;
    }

    // Anything that reaches this branch is unexpected: a non-DomainError,
    // non-HttpException value was thrown out of a handler. Page on-call.
    this.exceptions.exceptionsTotal.inc({
      kind: 'unhandled',
      status_family: '5xx',
    });
    this.sentry.captureException(exception, {
      requestId,
      path: req.url,
      method: req.method,
    });
    this.logger.error(
      { err: exception, requestId, path: req.url, method: req.method },
      'unhandled exception',
    );
    void res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: {},
        ...(requestId !== undefined ? { request_id: requestId } : {}),
      },
    });
  }
}
