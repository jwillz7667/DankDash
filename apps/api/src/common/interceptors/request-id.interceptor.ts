/**
 * Attach a stable request id to every inbound request and echo it back as
 * the `X-Request-Id` response header. If the caller already supplied one
 * (load balancer, mobile client, frontend), prefer that value so traces can
 * be stitched across systems. Otherwise mint a UUIDv7 — time-sortable and
 * cheap to filter on in pino-formatted log streams.
 *
 * The id is also surfaced on every error envelope by GlobalExceptionFilter
 * via `req.requestId`, and pushed onto the AsyncLocalStorage request
 * context (via `enterRequestContext`) so deep code paths can read it
 * without threading the request through every signature. The pino mixin
 * in `@dankdash/observability` reads the ALS context for every log
 * record.
 *
 * The interceptor also lifts the OTel trace/span ids onto the same
 * context when an active span exists. The OTel HTTP instrumentation
 * starts a server span before our interceptor runs, so the ids are
 * available by the time `intercept` fires. Without this, log records
 * have `request_id` but not `trace_id`, and stitching to Tempo traces
 * gets harder.
 */
import { enterRequestContext } from '@dankdash/observability';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Observable } from 'rxjs';
import { uuidv7 } from 'uuidv7';

const HEADER = 'x-request-id';

interface RequestWithId extends FastifyRequest {
  requestId?: string;
}

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithId>();
    const res = context.switchToHttp().getResponse<FastifyReply>();
    const incoming = req.headers[HEADER];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuidv7();
    req.requestId = id;
    void res.header('X-Request-Id', id);

    const span = trace.getActiveSpan();
    const spanCtx = span?.spanContext();
    enterRequestContext({
      requestId: id,
      ...(spanCtx !== undefined ? { traceId: spanCtx.traceId, spanId: spanCtx.spanId } : {}),
    });

    return next.handle();
  }
}
