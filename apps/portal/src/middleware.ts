/**
 * Edge middleware — gates every authenticated route on a valid session
 * cookie. Auth.js v5 exposes `auth()` as a middleware factory that
 * decodes the encrypted JWT and surfaces it on `req.auth`.
 *
 *   - `/login` and `/two-factor` are public (with one caveat: a
 *     fully-authenticated user landing on `/login` is bounced to
 *     `/dashboard` so the back button doesn't sit on the form).
 *   - `/api/auth/*` is always passthrough — Auth.js owns those.
 *   - Everything else requires a session. Without one we redirect to
 *     `/login?callbackUrl=<requested-path>`.
 *   - A session whose `mfaRequired` is true can only see `/two-factor`
 *     and the sign-out routes. Trying to reach anything else
 *     redirects to `/two-factor`.
 *   - A `RefreshAccessTokenError` on the session (the refresh token died)
 *     clears the cookie and forces a clean re-login — INCLUDING on
 *     `/login` itself, where it renders the form in place rather than
 *     bouncing to `/dashboard`. See `routeRequest` for why that branch
 *     order matters.
 *
 * The routing graph is the pure `routeRequest` in
 * `lib/auth/middleware-routing` (unit-tested without NextAuth); this
 * file decodes the session and applies the decision to a NextResponse.
 * The matcher excludes static assets so we don't pay the JWT decode for
 * every favicon hit.
 */
import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { resolveAuthConfig } from './lib/auth/config.js';
import { routeRequest, SESSION_COOKIE_NAMES } from './lib/auth/middleware-routing.js';

const { auth } = NextAuth(resolveAuthConfig());

export default auth((req) => {
  const { nextUrl } = req;
  const path = nextUrl.pathname;

  // Auth.js owns its own routes — never gate them.
  if (path.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const decision = routeRequest({ path, session: req.auth });

  let response: NextResponse;
  if (decision.kind === 'next') {
    response = NextResponse.next();
  } else {
    const target = new URL(decision.to, nextUrl);
    if (decision.callbackUrl !== undefined) {
      target.searchParams.set('callbackUrl', decision.callbackUrl);
    }
    response = NextResponse.redirect(target);
  }

  if (decision.clearSession === true) {
    clearSessionCookies(response);
  }

  return response;
});

/**
 * Expire every session-cookie variant. The deletion Set-Cookie must
 * carry `Secure` for the `__Secure-`-prefixed names — browsers reject a
 * Set-Cookie for a `__Secure-` cookie that lacks the attribute, so a
 * bare `cookies.delete(name)` silently fails to clear it (the original
 * cause of the un-clearable dead-session redirect loop). We set an
 * expired value with matching attributes instead.
 */
function clearSessionCookies(response: NextResponse): void {
  for (const name of SESSION_COOKIE_NAMES) {
    response.cookies.set(name, '', {
      path: '/',
      maxAge: 0,
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-'),
    });
  }
}

/**
 * Skip middleware on static assets and the Next.js internals; otherwise
 * apply it everywhere. The matcher exclusion is the recommended
 * Next.js pattern (see https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher).
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
