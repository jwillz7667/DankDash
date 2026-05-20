'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { type UserRole } from '../../lib/api/types.js';
import { cn } from '../../lib/cn.js';
import { Logo } from '../brand/logo.js';
import { PRIMARY_NAV, visibleFor } from './nav-items.js';

export interface SidebarProps {
  readonly role: UserRole;
}

/**
 * Left rail. White canvas, slate hairline border, the wordmark
 * pinned at the top, lucide glyphs per item, and a single moss
 * indicator bar against an `moss-50` wash for the active route.
 *
 * The 3-px left bar on active is intentional — it mirrors the
 * focus-ring convention so the active state and a keyboard-focused
 * item read as the same visual language at a glance.
 */
export function Sidebar({ role }: SidebarProps): ReactNode {
  const pathname = usePathname();
  const items = visibleFor(PRIMARY_NAV, role);

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white"
    >
      <div className="flex h-16 items-center px-6">
        <Link href="/dashboard" aria-label="DankDash for Business — Dashboard" className="block">
          <Logo variant="wordmark" height={26} />
        </Link>
      </div>
      <div className="px-3 pb-2 pt-2">
        <p className="px-3 text-2xs font-semibold uppercase tracking-wider text-slate-400">
          Workspace
        </p>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 px-3">
        {items.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || (item.key === 'settings' && pathname.startsWith('/settings'));
          return (
            <li key={item.key} className="relative">
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-moss-500"
                />
              ) : null}
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out',
                  active
                    ? 'bg-moss-50 text-moss-800'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4 shrink-0 transition-colors duration-150',
                    active ? 'text-moss-600' : 'text-slate-400 group-hover:text-slate-600',
                  )}
                  strokeWidth={2}
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-slate-100 px-6 py-4 text-2xs text-slate-400">
        <p>v1.0 · MN compliant</p>
      </div>
    </nav>
  );
}
