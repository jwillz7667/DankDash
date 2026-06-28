/**
 * Checkout session cookie. The exchanged access token never reaches the
 * browser as JS-readable state — it lives in an httpOnly cookie set by the
 * Server Action, read back only on the server. The cookie is short-lived
 * (the token's own TTL) and scoped to the checkout paths.
 *
 * The (de)serialization is pure and unit-tested; the cookie I/O is a thin
 * wrapper over `next/headers` so the rest of the app imports one surface.
 */
import { cookies } from 'next/headers';
import { z } from 'zod';
import { cookieSecure } from './env.js';

export const SESSION_COOKIE = 'dd_checkout';

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  cartId: z.string().uuid(),
  deliveryAddressId: z.string().uuid(),
});

export type CheckoutSession = z.infer<typeof sessionSchema>;

export function serializeSession(session: CheckoutSession): string {
  return JSON.stringify(session);
}

/** Parse a raw cookie value back into a session, or null if malformed. */
export function parseSession(raw: string | undefined): CheckoutSession | null {
  if (raw === undefined || raw.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = sessionSchema.safeParse(json);
  return result.success ? result.data : null;
}

export async function setCheckoutSession(
  session: CheckoutSession,
  maxAgeSeconds: number,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, serializeSession(session), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export async function getCheckoutSession(): Promise<CheckoutSession | null> {
  const store = await cookies();
  return parseSession(store.get(SESSION_COOKIE)?.value);
}

export async function clearCheckoutSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
