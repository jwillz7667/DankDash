import { redirect } from 'next/navigation';

/**
 * `/analytics` has no content of its own — it redirects to the default
 * tab. Keeps the sidebar item targeting a stable path while letting the
 * tab routes own the actual surfaces.
 */
export default function AnalyticsIndexPage(): never {
  redirect('/analytics/sales');
}
