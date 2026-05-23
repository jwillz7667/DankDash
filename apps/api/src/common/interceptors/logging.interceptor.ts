/**
 * Per-request structured access log + Prometheus histogram emission.
 *
 * Emits one INFO log line per completed request with method, path,
 * status, latency_ms, and the request id set by
 * {@link RequestIdInterceptor}. In the same callback, observes the
 * request duration + response size into the http histograms so the
 * Grafana api-overview dashboard has data for every served request.
 *
 * Errors are logged at the boundary by the GlobalExceptionFilter —
 * this interceptor only observes the success path via `next` so
 * failures do not double-count. The histogram emission, however,
 * does happen for error responses too: we tap both `next` and
 * `error` so 5xx and 4xx status families are visible in the latency
 * histograms.
 */
import { type Logger } from '@dankdash/config';
import { statusFamily, type HttpHistograms } from '@dankdash/observability';
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { tap, type Observable } from 'rxjs';
import { HTTP_HISTOGRAMS } from '../../infrastructure/observability.module.js';

type RequestWithId = FastifyRequest & {
  readonly requestId?: string;
};

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: Logger,
    @Inject(HTTP_HISTOGRAMS) private readonly http: HttpHistograms,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const req = context.switchToHttp().getRequest<RequestWithId>();
    const res = context.switchToHttp().getResponse<FastifyReply>();
    const method = req.method;
    return next.handle().pipe(
      tap({
        next: () => {
          this.record(start, method, req, res);
        },
        error: () => {
          this.record(start, method, req, res);
        },
      }),
    );
  }

  private record(start: bigint, method: string, req: RequestWithId, res: FastifyReply): void {
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    const status = res.statusCode;
    // Prefer the matched route template (`/v1/orders/:id`) over the
    // raw URL (`/v1/orders/abc-123`) — the histogram label cardinality
    // is bounded by the route count, not the request count.
    const route = req.routeOptions.url ?? req.url;
    const labels = {
      method,
      route,
      status_family: statusFamily(status),
    };
    this.http.requestDurationSeconds.observe(labels, elapsedSeconds);
    const contentLength = Number(res.getHeader('content-length') ?? 0);
    if (!Number.isNaN(contentLength) && contentLength > 0) {
      this.http.responseSizeBytes.observe(labels, contentLength);
    }
    this.logger.info(
      {
        method,
        path: req.url,
        status,
        latency_ms: Math.round(elapsedSeconds * 1_000 * 1_000) / 1_000,
        requestId: req.requestId,
      },
      'request completed',
    );
  }
}
