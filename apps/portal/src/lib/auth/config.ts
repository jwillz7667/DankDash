/**
 * Auth.js v5 (next-auth) configuration for the portal.
 *
 * - **Credentials provider** posts to `/v1/auth/login` on the DankDash API
 *   and stores the resulting JWT pair in the encrypted JWT session
 *   cookie. Auth.js does not manage user passwords itself — it relays
 *   them to our API once and never sees them again.
 *
 * - **Two-step MFA flow.** The login form submits twice when the API
 *   responds `mfa_required`. The page renders a 6-digit code input on
 *   that response and re-submits with `mode='mfa'` carrying the same
 *   email + the code + the `challengeId` from the first response. The
 *   *first* leg throws `MfaRequiredError` from `authorize` (we don't
 *   want a half-authenticated cookie); the *second* leg returns the
 *   user once the API has accepted the TOTP. The thrown error's `code`
 *   field reaches the client as `SignInResponse.code === 'mfa_required'`,
 *   which is how the login form tells "needs MFA" apart from "wrong
 *   password" (the latter still resolves to a null return).
 *
 * - **Token refresh** happens inside the `jwt` callback whenever the
 *   incoming token's `accessTokenExpiresAt` is within the refresh
 *   window. A failed refresh sets `token.error = 'RefreshAccessTokenError'`
 *   so the consumer can sign the user out on the next render.
 *
 * - **Portal role gate.** A user logging in with a `customer` or
 *   `driver` role is rejected here (not just in middleware) — the
 *   credentials provider returns null which Auth.js translates into a
 *   `CredentialsSignin` error.
 *
 * - **2FA enforcement** for `manager` / `owner` / `admin` is delegated
 *   to middleware (since the cookie is already minted by the time we
 *   get here). The session carries `mfaRequired: boolean` so middleware
 *   can force a redirect to `/two-factor` until the second factor lands.
 */
import { CredentialsSignin } from '@auth/core/errors';
import { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { ApiClient, ApiError } from '../api/client.js';
import {
  isPortalRole,
  requiresMfa,
  type DispensaryMembership,
  type LoginResponse,
  type StaffRole,
  type UserRole,
} from '../api/types.js';
import { loadPublicEnv, loadServerEnv, resolveApiBaseUrl } from '../env.js';

/**
 * Thrown from `authorize()` when the API responds `mfa_required`. Auth.js
 * surfaces the `code` to the client (`SignInResponse.code`) so the login
 * form can render the TOTP input *only* in this case — without it, the
 * form can't distinguish "needs MFA" from "wrong password" since both
 * paths otherwise look like `CredentialsSignin`.
 */
export class MfaRequiredError extends CredentialsSignin {
  override code = 'mfa_required';
}

/**
 * Shape of the User object authorize() returns. Auth.js's base `User`
 * is too permissive (id/email are optional) — we narrow to a portal
 * shape locally and cast at the framework boundaries (authorize return
 * + jwt callback `user` parameter). Keeping this private to config.ts
 * means tokens never leak into the global `next-auth` User type used
 * by the session callback.
 */
interface AuthorizedPortalUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly mfaEnabled: boolean;
  readonly kycVerified: boolean;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly mfaRequired: boolean;
  readonly dispensaryId: string | null;
  readonly dispensaryName: string | null;
  readonly staffRole: StaffRole | null;
}

// 60-second window before access-token expiry where we proactively
// refresh. Keeps a slow render from racing with the token's death.
const REFRESH_WINDOW_SECONDS = 60;

// Cookie ttl on the Auth.js session — matches the API's refresh-token
// TTL so the longest possible session never outlives the upstream
// credential.
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

interface CredentialsInput {
  readonly mode: 'password' | 'mfa';
  readonly email: string;
  readonly password: string;
  readonly mfaCode?: string;
  readonly challengeId?: string;
}

export interface BuildAuthConfigOptions {
  readonly apiBaseUrl: string;
  readonly authSecret: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pure factory — takes all I/O dependencies as args so unit tests
 * can build an entirely deterministic config without touching env or
 * the real network. The lazy `resolveAuthConfig` below threads env
 * through this factory for production code.
 */
export function buildAuthConfig(options: BuildAuthConfigOptions): NextAuthConfig {
  const { apiBaseUrl, authSecret, fetchImpl } = options;

  return {
    secret: authSecret,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
    pages: {
      signIn: '/login',
      error: '/login',
    },
    trustHost: true,
    providers: [
      Credentials({
        name: 'DankDash',
        credentials: {
          mode: { label: 'Mode', type: 'text' },
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
          mfaCode: { label: '2FA code', type: 'text' },
          challengeId: { label: 'Challenge ID', type: 'text' },
        },
        async authorize(rawCredentials) {
          const credentials = parseCredentials(rawCredentials);
          if (credentials === null) return null;

          const client = new ApiClient({
            baseUrl: apiBaseUrl,
            ...(fetchImpl !== undefined ? { fetchImpl } : {}),
          });
          let response: LoginResponse;
          try {
            response = await client.login({
              email: credentials.email,
              password: credentials.password,
              ...(credentials.mfaCode !== undefined ? { mfaCode: credentials.mfaCode } : {}),
            });
          } catch (err) {
            // Don't leak whether the email exists or the password was
            // wrong — both surface as a generic credentials error.
            if (err instanceof ApiError) {
              return null;
            }
            throw err;
          }

          if (response.status === 'mfa_required') {
            // First leg of the two-step. We throw a coded error
            // instead of returning null so the login form can tell
            // "needs MFA" apart from "wrong password" — both produce
            // CredentialsSignin otherwise. Auth.js exposes `code` on
            // the SignInResponse and as a query param on the error URL.
            throw new MfaRequiredError();
          }

          const { user, tokens } = response;
          if (!isPortalRole(user.role)) {
            return null;
          }

          const fullName = composeName(user.firstName, user.lastName);
          const mfaRequired = requiresMfa(user.role) && !user.mfaEnabled;
          // Only resolve dispensary context once the user is past MFA
          // gating — fetching memberships before the second factor would
          // burn an access token that the middleware is about to gate
          // behind /two-factor anyway. The fetch is fail-open: a network
          // failure leaves dispensaryId null and the dashboard renders a
          // "context unavailable" affordance rather than blocking sign-in.
          const membership = mfaRequired
            ? null
            : await resolveActiveDispensary(apiBaseUrl, tokens.accessToken, fetchImpl);
          const authorized: AuthorizedPortalUser = {
            id: user.id,
            email: user.email,
            name: fullName,
            role: user.role,
            mfaEnabled: user.mfaEnabled,
            kycVerified: user.kycVerified,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            mfaRequired,
            dispensaryId: membership?.id ?? null,
            dispensaryName: membership?.displayName ?? null,
            staffRole: membership?.staffRole ?? null,
          };
          // Cast to the framework's `User` — our extras ride along
          // into the jwt callback's `user` parameter, where we narrow
          // them back.
          return authorized;
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user, trigger }) {
        if (trigger === 'signIn' || trigger === 'signUp') {
          // First-leg sign-in: `user` is the object authorize() returned.
          // Auth.js v5 types `user` as always-defined here, but the
          // runtime only populates it when `trigger` indicates sign-in,
          // so gate on the trigger rather than a truthiness check.
          const portalUser = user as unknown as AuthorizedPortalUser;
          token.userId = portalUser.id;
          token.email = portalUser.email;
          token.name = portalUser.name;
          token.role = portalUser.role;
          token.mfaEnabled = portalUser.mfaEnabled;
          token.kycVerified = portalUser.kycVerified;
          token.accessToken = portalUser.accessToken;
          token.refreshToken = portalUser.refreshToken;
          token.accessTokenExpiresAt = portalUser.accessTokenExpiresAt;
          token.refreshTokenExpiresAt = portalUser.refreshTokenExpiresAt;
          token.mfaRequired = portalUser.mfaRequired;
          token.dispensaryId = portalUser.dispensaryId;
          token.dispensaryName = portalUser.dispensaryName;
          token.staffRole = portalUser.staffRole;
          delete token.error;
          return token;
        }

        if (trigger === 'update') {
          // A server action signaled the session changed (e.g. user
          // just enrolled in 2FA). Let next render through; the
          // consumer that called update() already wrote the new
          // fields onto the token.
          return token;
        }

        if (!isAccessTokenExpiringSoon(token.accessTokenExpiresAt)) {
          return token;
        }

        const refreshed = await refreshAccessToken(token.refreshToken, apiBaseUrl, fetchImpl);
        if (refreshed === null) {
          token.error = 'RefreshAccessTokenError';
          return token;
        }

        token.accessToken = refreshed.accessToken;
        token.refreshToken = refreshed.refreshToken;
        token.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
        token.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt;
        delete token.error;
        return token;
      },
      session({ session, token }) {
        session.user = {
          id: token.userId,
          // email/name inherit from DefaultJWT as optional + nullable;
          // we wrote them in the jwt callback above, so we coerce
          // back to the non-null portal shape here.
          email: token.email ?? '',
          name: token.name ?? null,
          role: token.role,
          mfaEnabled: token.mfaEnabled,
          kycVerified: token.kycVerified,
          // Auth.js types session.user as `AdapterUser & PortalShape`,
          // and AdapterUser requires `emailVerified`. We don't use the
          // database adapter path so this field is meaningless — set
          // it to null to satisfy the intersection.
          emailVerified: null,
        };
        session.accessToken = token.accessToken;
        session.refreshToken = token.refreshToken;
        session.accessTokenExpiresAt = token.accessTokenExpiresAt;
        session.refreshTokenExpiresAt = token.refreshTokenExpiresAt;
        session.mfaRequired = token.mfaRequired;
        session.dispensaryId = token.dispensaryId;
        session.dispensaryName = token.dispensaryName;
        session.staffRole = token.staffRole;
        if (token.error !== undefined) {
          session.error = token.error;
        }
        return session;
      },
    },
  };
}

function parseCredentials(raw: unknown): CredentialsInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const mode = candidate['mode'];
  const email = candidate['email'];
  const password = candidate['password'];
  if (mode !== 'password' && mode !== 'mfa') return null;
  if (typeof email !== 'string' || email.length === 0) return null;
  if (typeof password !== 'string' || password.length === 0) return null;
  const mfaCode = candidate['mfaCode'];
  const challengeId = candidate['challengeId'];
  return {
    mode,
    email,
    password,
    ...(typeof mfaCode === 'string' && mfaCode.length > 0 ? { mfaCode } : {}),
    ...(typeof challengeId === 'string' && challengeId.length > 0 ? { challengeId } : {}),
  };
}

function composeName(first: string | null, last: string | null): string | null {
  const f = first?.trim() ?? '';
  const l = last?.trim() ?? '';
  if (f.length === 0 && l.length === 0) return null;
  return `${f} ${l}`.trim();
}

function isAccessTokenExpiringSoon(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return true; // unparseable -> refresh immediately
  return expiry - Date.now() < REFRESH_WINDOW_SECONDS * 1000;
}

interface RefreshedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

/**
 * Pick the active dispensary context for a freshly signed-in user.
 *
 * Calls `GET /v1/me/dispensaries` with the bearer token from the login
 * response. The portal does not request `X-Dispensary-Id` for this call
 * (the endpoint is user-scoped, not vendor-scoped). The first accepted
 * membership wins — the API already orders by `joinedAt` ascending so
 * the most-tenured store floats first; pending invites (acceptedAt =
 * null) are skipped so the dashboard never silently lands on an
 * unaccepted store.
 *
 * Fail-open: any error (network, 5xx, parse) returns null. The dashboard
 * surfaces a "no dispensary context" state and vendor endpoints 403
 * until the user retries or accepts an invite.
 */
async function resolveActiveDispensary(
  apiBaseUrl: string,
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<DispensaryMembership | null> {
  const client = new ApiClient({
    baseUrl: apiBaseUrl,
    accessToken,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  try {
    const { memberships } = await client.listMyDispensaries();
    return memberships.find((m) => m.acceptedAt !== null) ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(
  refreshToken: string,
  apiBaseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<RefreshedTokens | null> {
  const client = new ApiClient({
    baseUrl: apiBaseUrl,
    refreshToken,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  try {
    const { tokens } = await client.refresh(refreshToken);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Threads env through `buildAuthConfig`. The `auth.ts` shim at the
 * src root calls this once at server boot; tests build their own
 * config via `buildAuthConfig` directly.
 */
export function resolveAuthConfig(): NextAuthConfig {
  const publicEnv = loadPublicEnv();
  const serverEnv = loadServerEnv();
  const apiBaseUrl = resolveApiBaseUrl(serverEnv, publicEnv);
  return buildAuthConfig({ apiBaseUrl, authSecret: serverEnv.AUTH_SECRET });
}
