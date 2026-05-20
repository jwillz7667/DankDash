/**
 * Helper for building an `ApiClient` inside a server context (route
 * handler, server action, server component). Reads the current Auth.js
 * session, injects the access + refresh tokens, and wires the API base
 * URL from env.
 *
 * The returned client is request-scoped — never cache it across requests
 * or it will leak tokens. The session itself is fetched once per call,
 * which is fine because Auth.js memoizes the decode inside the request.
 */
import { auth } from '../../auth.js';
import { loadPublicEnv, loadServerEnv, resolveApiBaseUrl } from '../env.js';
import { ApiClient } from './client.js';
import { type StaffRole, type UserRole } from './types.js';

export interface ServerApiContext {
  readonly client: ApiClient;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
  };
  /**
   * Active dispensary the client is scoped to. Null when the user has
   * no accepted memberships — vendor-scoped pages should redirect to a
   * picker (or render an empty state) rather than calling the API.
   */
  readonly dispensary: {
    readonly id: string;
    readonly name: string;
    readonly staffRole: StaffRole;
  } | null;
}

/**
 * Build a request-scoped API client bound to the caller's session.
 * Returns `null` when there is no authenticated session — callers
 * should treat that as "redirect to /login" rather than throwing,
 * because the middleware will already have caught the unauth case for
 * page navigations; this only triggers for direct route-handler hits
 * that slipped through the matcher.
 */
export async function buildServerApiClient(): Promise<ServerApiContext | null> {
  const session = await auth();
  if (!session) return null;

  const publicEnv = loadPublicEnv();
  const serverEnv = loadServerEnv();
  const baseUrl = resolveApiBaseUrl(serverEnv, publicEnv);

  const client = new ApiClient({
    baseUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    ...(session.dispensaryId !== null ? { dispensaryId: session.dispensaryId } : {}),
  });

  const dispensary =
    session.dispensaryId !== null && session.dispensaryName !== null && session.staffRole !== null
      ? {
          id: session.dispensaryId,
          name: session.dispensaryName,
          staffRole: session.staffRole,
        }
      : null;

  return {
    client,
    user: {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    },
    dispensary,
  };
}
