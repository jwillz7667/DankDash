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

/**
 * Push a context onto the *current* async execution scope without
 * needing a wrapper callback. Use this from a NestJS interceptor or
 * Fastify hook where we want every continuation of the current
 * request to see the context but cannot easily wrap the rest of the
 * request inside a closure.
 *
 * Prefer `runWithRequestContext` from boundary code that owns the
 * scope. Use `enterRequestContext` only where wrapping is awkward
 * (interceptors, controller decorators).
 */
export function enterRequestContext(context: RequestContext): void {
  als.enterWith(context);
}

/**
 * Mutate the current ALS-stored context in place. Useful when a guard
 * resolves the JWT subject after the request boundary middleware has
 * already created the context — we want `userId`/`dispensaryId` on
 * every later log without re-entering a new store. Safe because each
 * request has its own store; mutation is scoped to that one request.
 *
 * Returns `false` when there is no active context to update — callers
 * can decide whether that is an error or a no-op for their flow.
 */
export function updateRequestContext(patch: Partial<RequestContext>): boolean {
  const current = als.getStore();
  if (current === undefined) return false;
  Object.assign(current, patch);
  return true;
}
