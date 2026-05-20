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
 *   - A `RefreshAccessTokenError` on the session forces a re-login.
 *
 * The matcher excludes static assets so we don't pay the JWT decode
 * for every favicon hit.
 */
import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { resolveAuthConfig } from './lib/auth/config.js';

const { auth } = NextAuth(resolveAuthConfig());

const PUBLIC_PATHS = new Set<string>(['/login']);
const TWO_FACTOR_PATH = '/two-factor';

export default auth((req) => {
  const { nextUrl } = req;
  const session = req.auth;
  const path = nextUrl.pathname;

  // Public assets and Auth.js's own routes — let them through.
  if (path.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const isPublic = PUBLIC_PATHS.has(path);
  const isTwoFactor = path === TWO_FACTOR_PATH;

  // Refresh-token death: clobber the session and force re-login.
  if (session?.error === 'RefreshAccessTokenError') {
    if (!isPublic) {
      const loginUrl = new URL('/login', nextUrl);
      loginUrl.searchParams.set('callbackUrl', nextUrl.pathname);
      const response = NextResponse.redirect(loginUrl);
      response.cookies.delete('authjs.session-token');
      response.cookies.delete('__Secure-authjs.session-token');
      return response;
    }
  }

  if (session && isPublic) {
    // Already signed in; route home (or to /two-factor if outstanding).
    const target = session.mfaRequired ? TWO_FACTOR_PATH : '/dashboard';
    return NextResponse.redirect(new URL(target, nextUrl));
  }

  if (!session) {
    if (isPublic || isTwoFactor) {
      return NextResponse.next();
    }
    const loginUrl = new URL('/login', nextUrl);
    loginUrl.searchParams.set('callbackUrl', nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (session.mfaRequired && !isTwoFactor) {
    return NextResponse.redirect(new URL(TWO_FACTOR_PATH, nextUrl));
  }

  return NextResponse.next();
});

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
