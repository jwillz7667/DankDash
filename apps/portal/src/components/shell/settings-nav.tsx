'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { type UserRole } from '../../lib/api/types.js';
import { cn } from '../../lib/cn.js';
import { SETTINGS_NAV, visibleFor } from './nav-items.js';

export interface SettingsNavProps {
  readonly role: UserRole;
}

export function SettingsNav({ role }: SettingsNavProps): ReactNode {
  const pathname = usePathname();
  const items = visibleFor(SETTINGS_NAV, role);

  return (
    <nav aria-label="Settings" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out',
              active
                ? 'bg-moss-50 text-moss-800'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
            )}
          >
            {active ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-moss-500"
              />
            ) : null}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
