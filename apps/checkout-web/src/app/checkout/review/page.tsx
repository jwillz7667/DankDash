import Link from 'next/link';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { placeOrder } from '@/app/checkout/actions';
import { ReviewForm } from '@/app/checkout/review/review-form';
import { Brand } from '@/components/brand';
import { ComplianceSummary } from '@/components/compliance-summary';
import { getCart, validateCart } from '@/lib/api';
import { type Cart, type Compliance } from '@/lib/api-schemas';
import { CheckoutError } from '@/lib/errors';
import { formatCents } from '@/lib/format';
import { getCheckoutSession } from '@/lib/session';

const PLACE_ERRORS: Record<string, string> = {
  CHECKOUT_FAILED: 'We couldn’t complete your order. Please try again.',
  COMPLIANCE_BLOCKED: 'This order no longer meets compliance rules.',
  CART_UNAVAILABLE: 'Your cart could not be loaded. It may have expired.',
};

export default async function ReviewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getCheckoutSession();
  if (session === null) {
    redirect('/checkout/error?reason=session');
  }

  let cart: Cart;
  let compliance: Compliance;
  try {
    [cart, compliance] = await Promise.all([
      getCart(session.cartId, session.accessToken),
      validateCart(session.cartId, session.deliveryAddressId, session.accessToken),
    ]);
  } catch (err) {
    const message =
      err instanceof CheckoutError
        ? err.userMessage
        : 'We hit an unexpected error loading your order.';
    return (
      <main className="page">
        <Brand />
        <h1>Couldn’t load your order</h1>
        <div className="notice error">{message}</div>
        <Link className="btn btn-ghost" href="/checkout/error?reason=cart">
          Back to the app
        </Link>
      </main>
    );
  }

  const { error } = await props.searchParams;
  const placeError = typeof error === 'string' ? (PLACE_ERRORS[error] ?? null) : null;
  const itemCount = cart.items.reduce((n, i) => n + i.quantity, 0);

  return (
    <main className="page">
      <Brand />
      <h1>Review &amp; pay</h1>
      <p className="sub">Confirm your order and add a driver tip to complete checkout.</p>

      {placeError !== null ? <div className="notice error">{placeError}</div> : null}

      <div className="card" aria-label="Order summary">
        <h2>
          Your order · {itemCount} item{itemCount === 1 ? '' : 's'}
        </h2>
        {cart.items.map((item) => (
          <div className="row" key={item.id}>
            <span className="label">
              {item.quantity} × <span className="muted mono">{item.listingId.slice(0, 8)}</span>
            </span>
            <span className="mono">{formatCents(item.lineSubtotalCents)}</span>
          </div>
        ))}
        <div className="row total">
          <span>Subtotal</span>
          <span className="mono">{formatCents(cart.subtotalCents)}</span>
        </div>
      </div>

      <ComplianceSummary compliance={compliance} />

      {compliance.passed ? (
        <ReviewForm subtotalCents={cart.subtotalCents} action={placeOrder} />
      ) : (
        <Link className="btn btn-ghost" href="/checkout/error?reason=compliance">
          Return to the app
        </Link>
      )}

      <p className="fineprint">
        Taxes and the delivery fee are calculated at checkout. Payment is processed by Aeropay. You
        must be 21+ with a valid ID for delivery.
      </p>
    </main>
  );
}
