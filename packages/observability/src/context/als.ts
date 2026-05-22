/**
 * AsyncLocalStorage-backed request context.
 *
 * Nest's RequestId interceptor stores `requestId` on the Fastify
 * request object. That works for handlers but does not reach
 * repository methods or domain services without threading the
 * request through every signature. ALS gives every async-chained
 * descendant of the middleware boundary access to the same context
 * with zero plumbing.
 *
 * Usage:
 *
 *   import { runWithRequestContext, getRequestContext } from
 *     '@dankdash/observability/context';
 *
 *   // boundary
 *   await runWithRequestContext({ requestId: 'abc' }, async () => {
 *     await handler(req);
 *   });
 *
 *   // anywhere deeper
 *   const ctx = getRequestContext();   // { requestId: 'abc', ... }
 *
 * The store is process-global per ALS semantics. Concurrent requests
 * each get their own independent store; values never leak between
 * them, including across `await` boundaries — that is the whole
 * point of ALS.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './request-context.js';

const als = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` as the active request context. Awaited
 * descendants of `fn` see the same context; siblings outside the
 * `runWithRequestContext` boundary see whatever their ancestor stored
 * (or `undefined` if no ancestor).
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return als.run(context, fn);
}

/**
 * Returns the active request context, or `undefined` if called outside
 * any `runWithRequestContext` boundary. Consumers should treat
 * `undefined` as "no context available" rather than as a bug — code
 * paths reached from process startup, cron firing, or test setup
 * legitimately run without a context.
 */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/**
 * Convenience that returns the request id when context exists, or
 * `undefined`. Hot path for logging mixin code that cares only about
 * the id, not the wider context.
 */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
