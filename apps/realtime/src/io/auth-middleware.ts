/**
 * Connection-time auth middleware for every Socket.io namespace.
 *
 * Socket.io middleware runs once per connection, before any event listeners
 * fire. We verify the JWT and stash the typed claims on `socket.data` so
 * downstream handlers can read identity without re-verifying. A failure
 * here calls `next(err)` which Socket.io translates to a
 * `connect_error` on the client side — the client never sees a connected
 * socket.
 *
 * Token sources (checked in order):
 *   1. `socket.handshake.auth.token` — the canonical place per Socket.io
 *      docs; iOS and the vendor portal both use this.
 *   2. `Authorization: Bearer <token>` header — fallback for the
 *      Node-based test harness and any HTTP-style client.
 *
 * The auth middleware does NOT enforce role-by-namespace beyond a
 * basic check (e.g. /driver requires `role === 'driver'`); finer-grained
 * authorization (which driver, which dispensary) is the responsibility
 * of the per-namespace join handlers, which consult the membership
 * repository.
 */
import { AuthError, ConfigError, ForbiddenError } from '@dankdash/types';
import type { RealtimeAccessTokenClaims, RealtimeJwtVerifier } from '../auth/jwt.js';
import type { Logger } from '@dankdash/config';
import type { Namespace, Socket } from 'socket.io';

/**
 * Socket.io's middleware `next(err)` accepts an Error-with-optional-data
 * object — the v4 type is exported from `socket.io/dist/namespace` but that
 * subpath is not part of the package's public `exports` map. Defining the
 * shape locally keeps us on the stable surface and avoids subpath churn.
 */
interface ExtendedError extends Error {
  data?: unknown;
}

export type AllowedRole = 'customer' | 'vendor' | 'driver';

export interface AuthenticatedSocketData {
  readonly claims: RealtimeAccessTokenClaims;
  /** Resolved at middleware time — vendor + driver namespaces use this. */
  readonly namespaceRole: AllowedRole;
}

const VENDOR_ROLES = new Set(['budtender', 'manager', 'owner']);
const DRIVER_ROLE = 'driver';

export interface AuthMiddlewareOptions {
  readonly verifier: RealtimeJwtVerifier;
  readonly allowedRole: AllowedRole;
  readonly logger: Logger;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  return (socket: Socket, next: (err?: ExtendedError) => void): void => {
    try {
      const token = extractToken(socket);
      if (token === null) {
        throw new AuthError('UNAUTHENTICATED', 'missing auth token');
      }
      const claims = options.verifier.verify(token);
      enforceRole(options.allowedRole, claims.role);
      const data: AuthenticatedSocketData = {
        claims,
        namespaceRole: options.allowedRole,
      };
      // socket.data is `Record<string, unknown>` at the framework level; we
      // narrow on read through `getSocketData`. Assignment must merge so
      // a subsequent middleware (rate-limit, audit) can hang its own keys.
      Object.assign(socket.data, data);
      next();
    } catch (err) {
      const failure =
        err instanceof AuthError || err instanceof ForbiddenError
          ? err
          : new AuthError('TOKEN_INVALID', 'unauthenticated', {}, err);
      // Log at info — auth failures are routine (expired tokens, dropped
      // sessions). The detail goes into the structured fields so a real
      // attack pattern still shows up under aggregation.
      options.logger.info(
        {
          event: 'realtime.auth.rejected',
          code: failure.code,
          remoteAddress: socket.handshake.address,
          namespace: socket.nsp.name,
        },
        'realtime: auth rejected',
      );
      next(toExtendedError(failure));
    }
  };
}

export function getSocketData(socket: Socket): AuthenticatedSocketData {
  const data = socket.data as Partial<AuthenticatedSocketData>;
  const { claims, namespaceRole } = data;
  if (claims === undefined || namespaceRole === undefined) {
    // Reaching this branch means the auth middleware was bypassed —
    // a programming error in the namespace wiring. Surface as an
    // explicit error rather than `null`-cascading into broken authz.
    throw new ConfigError(
      'CONFIG_INVALID',
      'socket.data missing auth claims — auth middleware not installed?',
    );
  }
  return { claims, namespaceRole };
}

function extractToken(socket: Socket): string | null {
  const handshakeAuth = socket.handshake.auth as Record<string, unknown>;
  const authToken = handshakeAuth['token'];
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;
  const header = socket.handshake.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}

function enforceRole(allowed: AllowedRole, claimRole: string): void {
  if (allowed === 'driver') {
    if (claimRole !== DRIVER_ROLE) {
      throw new ForbiddenError('role not permitted on /driver', { claimRole });
    }
    return;
  }
  if (allowed === 'vendor') {
    if (!VENDOR_ROLES.has(claimRole)) {
      throw new ForbiddenError('role not permitted on /vendor', { claimRole });
    }
    return;
  }
  // 'customer' namespace is the broadest — any non-driver, non-admin role
  // we recognize today maps to a customer experience. Admin roles can
  // observe via tooling, not this socket.
  if (claimRole === 'driver') {
    throw new ForbiddenError('driver role must use /driver namespace', { claimRole });
  }
}

function toExtendedError(err: AuthError | ForbiddenError): ExtendedError {
  const out = new Error(err.message) as ExtendedError;
  out.name = err.name;
  out.data = { code: err.code };
  return out;
}

/**
 * Resolves the configured Namespace by name. Tiny wrapper so test code
 * can pull the same handle without reaching into io.of('/customer').
 */
export function namespace(io: { of(name: string): Namespace }, name: string): Namespace {
  return io.of(name);
}
