/**
 * Per-request context carried through the request lifecycle.
 *
 * Every authenticated boundary populates `userId` after the guard has
 * resolved a session. `dispensaryId` is populated by VendorContextGuard
 * for vendor-portal routes. `traceId` / `spanId` are best-effort —
 * present when the OTel SDK is initialized, absent in test runs that
 * skip the bootstrap. `requestId` is always present.
 *
 * The shape is `readonly` because consumers must not mutate the context
 * mid-request; instead, run a nested `als.run` if a child scope needs
 * different values.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly userId?: string;
  readonly dispensaryId?: string;
}

export type WithRequestId = Pick<RequestContext, 'requestId'>;
