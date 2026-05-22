import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { PagePlaceholder } from '../../../components/shell/page-placeholder.js';

export const metadata: Metadata = {
  title: 'Payouts — DankDash for Business',
};

export default function PayoutsPage(): ReactNode {
  return (
    <PagePlaceholder
      title="Payouts"
      description="Weekly settlement runs, payout transactions, and bank-account configuration."
      phase="Phase 18"
    >
      <p>
        Settlement math already runs server-side (Phase 6); this surface will expose the per-week
        statement, download links for accounting, and the Stripe Connect onboarding flow.
      </p>
    </PagePlaceholder>
  );
}
