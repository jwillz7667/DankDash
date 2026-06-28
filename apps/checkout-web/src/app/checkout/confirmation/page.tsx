import { type ReactNode } from 'react';
import { Brand } from '@/components/brand';
import { formatCents, orderCompleteDeepLink } from '@/lib/format';

/**
 * Order confirmation. Shows the short code + total and, crucially, the deep
 * link back into the iOS app (`dankdash://order/complete?orderId=…`) — the
 * return trip the consumer app's OrderTracking flow is waiting on. We render
 * it as a normal link (a tap target) rather than auto-navigating, so the
 * Safari hand-off stays user-initiated.
 */
export default async function ConfirmationPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await props.searchParams;
  const orderId = typeof params.order === 'string' ? params.order : '';
  const code = typeof params.code === 'string' ? params.code : '';
  const totalCents = typeof params.total === 'string' ? Number(params.total) : NaN;

  if (orderId.length === 0) {
    return (
      <main className="page">
        <Brand />
        <h1>Order received</h1>
        <p className="sub">Your order is being prepared. You can track it in the DankDash app.</p>
      </main>
    );
  }

  return (
    <main className="page center">
      <Brand />
      <div className="success-check" aria-hidden="true">
        ✓
      </div>
      <h1>Order placed</h1>
      <p className="sub">
        {code.length > 0 ? (
          <>
            Confirmation <strong className="mono">{code}</strong>.{' '}
          </>
        ) : null}
        Your driver will verify your ID (21+) at handoff.
      </p>

      {Number.isFinite(totalCents) ? (
        <div className="card">
          <div className="row total" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
            <span>Total charged</span>
            <span className="mono">{formatCents(totalCents)}</span>
          </div>
        </div>
      ) : null}

      <a className="btn btn-primary" href={orderCompleteDeepLink(orderId)}>
        Return to the DankDash app
      </a>
      <p className="fineprint">
        Track your delivery in real time from the app. You can close this window.
      </p>
    </main>
  );
}
