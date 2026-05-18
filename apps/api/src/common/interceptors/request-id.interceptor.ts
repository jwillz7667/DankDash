/**
 * Attach a stable request id to every inbound request and echo it back as
 * the `X-Request-Id` response header. If the caller already supplied one
 * (load balancer, mobile client, frontend), prefer that value so traces can
 * be stitched across systems. Otherwise mint a UUIDv7 — time-sortable and
 * cheap to filter on in pino-formatted log streams.
 *
 * The id is also surfaced on every error envelope by GlobalExceptionFilter
 * via `req.requestId`.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
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
    return next.handle();
  }
}
