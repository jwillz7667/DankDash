/**
 * Server-only proxy for POST /v1/auth/mfa/verify.
 *
 * The browser never sees the portal session cookie's contents, so we
 * forward the request through this route. The handler reads the
 * Auth.js session, pulls the access token, and calls the API with
 * the same JSON the API expects.
 *
 * We keep this as a thin proxy rather than hitting the API directly
 * from the client so that:
 *
 *   - The access token does not have to be exposed to the browser.
 *   - The proxy can be the single place we react to a `RefreshAccessToken`
 *     failure (clear the cookie, redirect to /login).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '../../../../../auth.js';
import { ApiClient, ApiError } from '../../../../../lib/api/client.js';
import { loadPublicEnv, loadServerEnv, resolveApiBaseUrl } from '../../../../../lib/env.js';

const BodySchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'sign in required', details: {} } },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'invalid body', details: {} } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'code must be 6 digits',
          details: {},
        },
      },
      { status: 400 },
    );
  }

  const publicEnv = loadPublicEnv();
  const serverEnv = loadServerEnv();
  const client = new ApiClient({
    baseUrl: resolveApiBaseUrl(serverEnv, publicEnv),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });

  try {
    await client.request<unknown>('/v1/auth/mfa/verify', {
      method: 'POST',
      body: parsed.data,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        err.envelope ?? { error: { code: err.code, message: err.message, details: {} } },
        {
          status: err.status,
        },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'unexpected error', details: {} } },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
