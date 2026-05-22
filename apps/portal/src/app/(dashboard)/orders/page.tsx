import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { PagePlaceholder } from '../../../components/shell/page-placeholder.js';

export const metadata: Metadata = {
  title: 'Orders — DankDash for Business',
};

export default function OrdersPage(): ReactNode {
  return (
    <PagePlaceholder
      title="Orders"
      description="Live queue across pending, accepted, prepping, en-route, and delivered orders."
      phase="Phase 14"
    >
      <p>
        Phase 14 will plug the column-board into the realtime client (already wired in Phase 13:{' '}
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
          useRealtimeOrders
        </code>
        ) and the Orders REST API so accept/reject/transition actions flow through the
        server-authoritative state machine.
      </p>
    </PagePlaceholder>
  );
}
