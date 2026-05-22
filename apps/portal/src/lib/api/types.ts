/**
 * Types mirrored from `apps/api`'s auth DTOs.
 *
 * We DO NOT import the API package directly — pulling NestJS metadata
 * through Next's bundler trips decorator and reflect-metadata code paths
 * that have no business in the browser. The DTO definitions in
 * `apps/api/src/modules/auth/dto/` are the source of truth; this file is
 * a hand-mirrored projection of the wire shape, kept narrow so a drift
 * shows up as a typecheck failure in the consumer (login form, server
 * action, refresh path).
 *
 * If the API contract changes, mirror it here and update the consumer in
 * the same PR. The OpenAPI-generation path in `packages/types` (Phase
 * 0.13) will eventually replace this hand-mirroring with `openapi-typescript`
 * output; until that lands, conventional commits prefixed `feat(portal):`
 * touching this file are the audit trail.
 */

export type UserRole =
  | 'customer'
  | 'budtender'
  | 'manager'
  | 'owner'
  | 'driver'
  | 'admin'
  | 'superadmin';

export type UserStatus = 'pending_kyc' | 'active' | 'suspended' | 'banned';

/**
 * Per-dispensary role from the `dispensary_staff` table. Distinct from
 * the global `UserRole` on the JWT — a single user may hold `manager`
 * at one store and `budtender` at another. The portal gates store-level
 * affordances (e.g. settings, payouts) on this rather than the global
 * role.
 */
export type StaffRole = 'budtender' | 'manager' | 'owner';

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly kycVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly createdAt: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly tokenType: 'Bearer';
}

export interface LoginSuccessResponse {
  readonly status: 'authenticated';
  readonly user: UserSummary;
  readonly tokens: TokenPair;
}

export interface LoginMfaRequiredResponse {
  readonly status: 'mfa_required';
  readonly challengeId: string;
  readonly challengeExpiresAt: string;
}

export type LoginResponse = LoginSuccessResponse | LoginMfaRequiredResponse;

export interface RefreshResponse {
  readonly tokens: TokenPair;
}

/**
 * One row from `GET /v1/me/dispensaries`. The portal fetches the list
 * once at sign-in (Auth.js jwt callback `signIn` trigger), picks the
 * first accepted membership, and threads its `id` as `X-Dispensary-Id`
 * on every subsequent vendor-scoped request.
 *
 *   - `acceptedAt: null` indicates a pending invite — the portal hides
 *     these from the picker and never auto-selects them.
 *   - `displayName` is the dispensary's `dba ?? legalName`, never null.
 *   - The list is ordered by `joinedAt` ascending (most-tenured first)
 *     so the first accepted row is also the primary store.
 */
export interface DispensaryMembership {
  readonly id: string;
  readonly displayName: string;
  readonly staffRole: StaffRole;
  readonly acceptedAt: string | null;
  readonly joinedAt: string;
}

export interface DispensaryMembershipsResponse {
  readonly memberships: readonly DispensaryMembership[];
}

/**
 * Roles allowed to use the vendor portal. Customer/driver tokens are
 * rejected at the middleware layer — the API would reject them anyway,
 * but failing at the portal gate avoids leaking the "you have an account
 * here but it's the wrong account" UX problem.
 */
export const PORTAL_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'budtender',
  'manager',
  'owner',
  'admin',
  'superadmin',
]);

/**
 * Roles for whom 2FA is mandatory. Budtenders are explicitly NOT on this
 * list: they sign in on a shared store device, and forcing TOTP on every
 * shift change is hostile to the actual workflow. Managers + owners +
 * admins handle money and configuration, and warrant the friction.
 */
export const ROLES_REQUIRING_MFA: ReadonlySet<UserRole> = new Set<UserRole>([
  'manager',
  'owner',
  'admin',
  'superadmin',
]);

export function isPortalRole(role: UserRole): boolean {
  return PORTAL_ROLES.has(role);
}

export function requiresMfa(role: UserRole): boolean {
  return ROLES_REQUIRING_MFA.has(role);
}
