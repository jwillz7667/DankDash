/**
 * Per-request structured access log. Emits one INFO line per completed
 * request with method, path, status, latency_ms, and the request id set by
 * {@link RequestIdInterceptor}. Errors are logged at the boundary by the
 * GlobalExceptionFilter — this interceptor only observes success paths via
 * `next` so failures don't double-log.
 */
import { type Logger } from '@dankdash/config';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { tap, type Observable } from 'rxjs';

interface RequestWithId extends FastifyRequest {
  readonly requestId?: string;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const req = context.switchToHttp().getRequest<RequestWithId>();
    const res = context.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(
      tap({
        next: () => {
          const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          this.logger.info(
            {
              method: req.method,
              path: req.url,
              status: res.statusCode,
              latency_ms: Math.round(latencyMs * 1000) / 1000,
              requestId: req.requestId,
            },
            'request completed',
          );
        },
      }),
    );
  }
}
