'use client';

/**
 * Sub-nav for `/analytics/sales` ↔ `/analytics/products`. Preserves the
 * `?from=&to=` query string when switching tabs so the date range picker
 * in the layout doesn't reset on every navigation.
 */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

interface AnalyticsTab {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

const TABS: ReadonlyArray<AnalyticsTab> = [
  { key: 'sales', label: 'Sales', href: '/analytics/sales' },
  { key: 'products', label: 'Products', href: '/analytics/products' },
];

export function AnalyticsTabs(): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();

  return (
    <nav aria-label="Analytics sections" className="border-b border-outline">
      <ul className="-mb-px flex items-center gap-1">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          const href = qs.length > 0 ? `${tab.href}?${qs}` : tab.href;
          return (
            <li key={tab.key}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-10 items-center border-b-2 px-4 text-sm font-medium transition-colors duration-150 ease-out',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 focus-visible:ring-offset-1',
                  active
                    ? 'border-moss-500 text-foreground'
                    : 'border-transparent text-secondary hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
