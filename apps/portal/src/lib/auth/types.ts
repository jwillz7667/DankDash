/**
 * Auth.js module augmentation.
 *
 *   - We augment `Session` and the `JWT` interfaces — not `User`. The
 *     base `User` shape is used in the session-callback's `session.user`
 *     intersection via `AdapterUser`, so adding fields to `User` would
 *     force every assignment to `session.user` to redundantly include
 *     them. Tokens and role live on `JWT` (server-only) and project
 *     into `Session` at the callback boundary.
 *
 *   - The fields authorize() returns above-and-beyond the base `User`
 *     shape (role, mfaEnabled, tokens, …) are typed via the local
 *     `AuthorizedUser` interface in `config.ts`; the credentials
 *     provider casts its return type, and the jwt callback casts its
 *     `user` parameter, so the type narrowing stays scoped to the
 *     callback site.
 *
 *   - `next-auth/jwt` is documented but cannot be augmented directly
 *     under `moduleResolution: 'bundler'` because it `export *`s from
 *     `@auth/core/jwt`. We augment the underlying module instead.
 */
import type { StaffRole, UserRole } from '../api/types.js';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string | null;
      role: UserRole;
      mfaEnabled: boolean;
      kycVerified: boolean;
    };
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    mfaRequired: boolean;
    /**
     * Active dispensary context resolved at sign-in. Null when the user
     * holds no accepted memberships (e.g. a global admin without store
     * staffing) — the dashboard renders a "no dispensary context" state
     * and vendor-scoped requests will 403 until the user accepts an
     * invite.
     */
    dispensaryId: string | null;
    dispensaryName: string | null;
    staffRole: StaffRole | null;
    error?: 'RefreshAccessTokenError';
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId: string;
    role: UserRole;
    mfaEnabled: boolean;
    kycVerified: boolean;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    mfaRequired: boolean;
    dispensaryId: string | null;
    dispensaryName: string | null;
    staffRole: StaffRole | null;
    error?: 'RefreshAccessTokenError';
  }
}

export {};
