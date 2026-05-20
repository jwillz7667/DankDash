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
import { type UserRole } from './types.js';

export interface ServerApiContext {
  readonly client: ApiClient;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
  };
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
  });

  return {
    client,
    user: {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    },
  };
}
