import { type ReactNode } from 'react';
import { Brand } from '@/components/brand';

const REASONS: Record<string, { title: string; message: string }> = {
  link: {
    title: 'Checkout link expired',
    message:
      'This checkout link is missing or invalid. Return to the DankDash app and tap Continue to checkout again.',
  },
  EXCHANGE_FAILED: {
    title: 'Checkout link expired',
    message:
      'This checkout link has expired or was already used. Return to the DankDash app and tap Continue to checkout again.',
  },
  session: {
    title: 'Session expired',
    message:
      'Your checkout session timed out. Return to the DankDash app and tap Continue to checkout to start again.',
  },
  cart: {
    title: 'Cart unavailable',
    message:
      'We couldn’t load your cart — it may have expired. Open the DankDash app and try checkout again.',
  },
  compliance: {
    title: 'Order can’t be completed',
    message:
      'This order doesn’t meet Minnesota cannabis rules (purchase limits, delivery area, or store hours). Adjust your cart in the app.',
  },
};

const FALLBACK = {
  title: 'Something went wrong',
  message: 'We hit an unexpected error. Return to the DankDash app and try checkout again.',
};

export default async function CheckoutErrorPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { reason } = await props.searchParams;
  const key = typeof reason === 'string' ? reason : '';
  const content = REASONS[key] ?? FALLBACK;

  return (
    <main className="page">
      <Brand />
      <h1>{content.title}</h1>
      <div className="notice error">{content.message}</div>
      <p className="fineprint">Your card was not charged.</p>
    </main>
  );
}
