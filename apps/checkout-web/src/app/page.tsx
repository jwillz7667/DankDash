import { type ReactNode } from 'react';
import { Brand } from '@/components/brand';

/**
 * Root landing. Nobody navigates here directly in the normal flow — the iOS
 * app opens `/checkout?handoff=<token>`. This is the graceful fallback for a
 * bare visit.
 */
export default function HomePage(): ReactNode {
  return (
    <main className="page">
      <Brand />
      <h1>Checkout</h1>
      <p className="sub">
        This page completes a DankDash order started in the app. Open the DankDash app, build your
        cart, and tap <strong>Continue to checkout</strong> to come back here securely.
      </p>
      <div className="notice info">
        Nothing to check out yet. Your checkout link is created when you tap checkout in the app.
      </div>
    </main>
  );
}
