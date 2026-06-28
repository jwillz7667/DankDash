import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { startCheckout } from '@/app/checkout/actions';
import { StartForm } from '@/app/checkout/start-form';
import { Brand } from '@/components/brand';
import { getCheckoutSession } from '@/lib/session';

/**
 * The fixed landing the iOS Safari hand-off opens:
 * `${CHECKOUT_BASE_URL}/checkout?handoff=<jwt>`.
 *
 * The exchange must run inside a Server Action (only those may set the
 * session cookie, and the one-shot token must be consumed exactly once), so
 * this page only stages the token into an auto-submitting form. If a session
 * already exists (a reload after exchange) we skip straight to review; if the
 * link is missing we show the expired-link state.
 */
export default async function CheckoutEntryPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  if ((await getCheckoutSession()) !== null) {
    redirect('/checkout/review');
  }

  const { handoff } = await props.searchParams;
  const token = typeof handoff === 'string' ? handoff : '';

  if (token.length === 0) {
    return (
      <main className="page">
        <Brand />
        <h1>Checkout link expired</h1>
        <p className="sub">
          This checkout link is missing or has expired. Return to the DankDash app and tap
          <strong> Continue to checkout</strong> again.
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <Brand />
      <h1>Preparing your checkout…</h1>
      <p className="sub">Securely signing you in. This only takes a moment.</p>
      <StartForm handoff={token} action={startCheckout} />
    </main>
  );
}
