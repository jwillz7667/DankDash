/**
 * Pure routing logic for the edge middleware, split out from
 * `src/middleware.ts` so it can be unit-tested without importing
 * `NextAuth(resolveAuthConfig())` — that call runs at module load and
 * needs real env, which a unit test shouldn't require. The middleware
 * decodes the session and applies these decisions to a NextResponse.
 */

export const LOGIN_PATH = '/login';
export const TWO_FACTOR_PATH = '/two-factor';
export const DASHBOARD_PATH = '/dashboard';

/**
 * Auth.js's default session cookie names (no custom `cookies` config in
 * `buildAuthConfig`). Production is HTTPS → the `__Secure-`-prefixed
 * variant; dev/HTTP → the bare name. We clear both. Chunked variants
 * (`.0`/`.1`, emitted only when the JWT exceeds ~4KB) are cleared too so
 * a large session can't leave an orphan chunk behind.
 */
export const SESSION_COOKIE_NAMES = [
  'authjs.session-token',
  'authjs.session-token.0',
  'authjs.session-token.1',
  '__Secure-authjs.session-token',
  '__Secure-authjs.session-token.0',
  '__Secure-authjs.session-token.1',
] as const;

export const REFRESH_ERROR = 'RefreshAccessTokenError';

export type MiddlewareSession = {
  readonly error?: string;
  readonly mfaRequired?: boolean;
} | null;

export type MiddlewareDecision =
  | { readonly kind: 'next'; readonly clearSession?: boolean }
  | {
      readonly kind: 'redirect';
      readonly to: string;
      readonly callbackUrl?: string;
      readonly clearSession?: boolean;
    };

/**
 * Pure routing decision for an authenticated-or-not request. No I/O, no
 * NextResponse — returns what the wrapper should do. Branch order is
 * load-bearing:
 *
 * The dead-session (`RefreshAccessTokenError`) case is handled FIRST and
 * for ALL paths. Previously it only acted on non-public paths and then
 * fell through to "healthy session on /login → /dashboard" — so a dead
 * session sitting on /login bounced to /dashboard, which re-detected the
 * error and bounced back to /login: an infinite "too many redirects"
 * loop that only a manual cookie wipe could break. Rendering /login in
 * place (and clearing the cookie) is the fix.
 *
 * Callers handle `/api/auth/*` (Auth.js's own routes) as passthrough
 * before reaching this function.
 */
export function routeRequest(input: {
  readonly path: string;
  readonly session: MiddlewareSession;
}): MiddlewareDecision {
  const { path, session } = input;
  const isLogin = path === LOGIN_PATH;
  const isTwoFactor = path === TWO_FACTOR_PATH;

  // Dead session: clear the cookie everywhere. On /login, render the form
  // (do NOT bounce to /dashboard — that's the redirect loop). Elsewhere,
  // redirect to /login carrying the attempted path.
  if (session?.error === REFRESH_ERROR) {
    if (isLogin) {
      return { kind: 'next', clearSession: true };
    }
    return { kind: 'redirect', to: LOGIN_PATH, callbackUrl: path, clearSession: true };
  }

  // Healthy session already on /login → route home (or to /two-factor if
  // a second factor is still outstanding).
  if (session && isLogin) {
    return { kind: 'redirect', to: session.mfaRequired ? TWO_FACTOR_PATH : DASHBOARD_PATH };
  }

  if (!session) {
    if (isLogin || isTwoFactor) {
      return { kind: 'next' };
    }
    return { kind: 'redirect', to: LOGIN_PATH, callbackUrl: path };
  }

  if (session.mfaRequired && !isTwoFactor) {
    return { kind: 'redirect', to: TWO_FACTOR_PATH };
  }

  return { kind: 'next' };
}
