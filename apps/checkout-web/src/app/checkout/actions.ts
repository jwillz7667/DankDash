'use server';

import { redirect } from 'next/navigation';
import { exchangeHandoff, placeCheckout } from '@/lib/api';
import { CheckoutError } from '@/lib/errors';
import { isValidTipCents, MIN_DRIVER_TIP_CENTS, MAX_DELIVERY_INSTRUCTIONS } from '@/lib/format';
import { clearCheckoutSession, getCheckoutSession, setCheckoutSession } from '@/lib/session';

/**
 * Exchange the one-shot hand-off token for a session and move to review.
 *
 * Idempotent: the exchange is single-shot server-side (the API revokes the
 * `jti` on first use), so a double submit — React strict-mode remount, a
 * double tap, a reload — must NOT attempt a second exchange. If a session
 * cookie already exists we go straight to review; only a first, cookieless
 * call hits the API. All `redirect()` calls sit OUTSIDE the try/catch so the
 * framework's redirect signal is never swallowed as an error.
 */
export async function startCheckout(formData: FormData): Promise<void> {
  if ((await getCheckoutSession()) !== null) {
    redirect('/checkout/review');
  }

  const handoff = formData.get('handoff');
  if (typeof handoff !== 'string' || handoff.length === 0) {
    redirect('/checkout/error?reason=link');
  }

  let target = '/checkout/review';
  try {
    const session = await exchangeHandoff(handoff);
    await setCheckoutSession(
      {
        accessToken: session.accessToken,
        cartId: session.cartId,
        deliveryAddressId: session.deliveryAddressId,
      },
      session.expiresInSeconds,
    );
  } catch (err) {
    target = `/checkout/error?reason=${err instanceof CheckoutError ? err.code : 'unknown'}`;
  }
  redirect(target);
}

/**
 * Place the order with the cart + address bound to the session, plus the tip
 * and instructions from the form. The API re-runs compliance inside the same
 * transaction, so a stale client view cannot push a non-compliant order
 * through. On success we clear the session and hand the user to the
 * confirmation screen (which deep-links back into the iOS app).
 */
export async function placeOrder(formData: FormData): Promise<void> {
  const session = await getCheckoutSession();
  if (session === null) {
    redirect('/checkout/error?reason=session');
  }

  const rawTip = Number(formData.get('driverTipCents'));
  const driverTipCents = isValidTipCents(rawTip) ? rawTip : MIN_DRIVER_TIP_CENTS;
  const rawInstructions = formData.get('deliveryInstructions');
  const deliveryInstructions =
    typeof rawInstructions === 'string'
      ? rawInstructions.trim().slice(0, MAX_DELIVERY_INSTRUCTIONS)
      : '';

  let target: string;
  try {
    const result = await placeCheckout(session.cartId, session.accessToken, {
      deliveryAddressId: session.deliveryAddressId,
      driverTipCents,
      ...(deliveryInstructions.length > 0 ? { deliveryInstructions } : {}),
    });
    await clearCheckoutSession();
    const q = new URLSearchParams({
      order: result.order.id,
      code: result.order.shortCode,
      total: String(result.order.totalCents),
    }).toString();
    target = `/checkout/confirmation?${q}`;
  } catch (err) {
    // Keep the session so the customer can retry; surface the reason on review.
    target = `/checkout/review?error=${err instanceof CheckoutError ? err.code : 'unknown'}`;
  }
  redirect(target);
}
