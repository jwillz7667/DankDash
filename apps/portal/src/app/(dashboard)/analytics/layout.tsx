import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { AnalyticsTabs } from '../../../components/analytics/analytics-tabs.js';
import { DateRangePicker } from '../../../components/analytics/date-range-picker.js';

export const metadata: Metadata = {
  title: 'Analytics — DankDash for Business',
};

/**
 * Layout wrapper for the analytics surface. The header + tab nav +
 * date picker live here so the `?from=&to=` window stays in the URL
 * as the operator flips between the Sales and Products tabs. The
 * picker itself reads/writes the query string via `useRouter`, so the
 * sub-pages (server components) re-fetch the data on every change
 * without any cross-component state plumbing.
 */
export default function AnalyticsLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">
            Performance
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Analytics</h1>
          <p className="max-w-2xl text-sm text-muted">
            Revenue, top sellers, and the slow-movers that need attention. Numbers cover delivered
            orders only — pending and returned orders don't count.
          </p>
        </div>
        <DateRangePicker />
      </header>
      <AnalyticsTabs />
      {children}
    </div>
  );
}
