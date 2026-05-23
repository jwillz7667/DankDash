'use client';

import { Bell, ChevronDown, LogOut, Search, Store } from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface TopBarProps {
  readonly email: string;
  readonly displayName: string | null;
  readonly role: string;
  /**
   * Single dispensary scope today. The multi-dispensary switcher
   * lands in Phase 15 once a user can be active across stores; the
   * UI here renders the (single) dispensary name as a static label
   * so the layout matches what the switcher will replace.
   */
  readonly dispensaryName?: string;
}

/**
 * Top chrome. Three slots, left-to-right:
 *
 *   1. Dispensary scope chip — single-store today, picker in Phase 15.
 *   2. Search trigger styled like a command palette entry — the actual
 *      palette ships in Phase 17; until then this is a presentational
 *      hint that anchors the layout. Disabled, no handlers.
 *   3. Notifications bell + user menu. The bell is a presentational
 *      affordance until Phase 17 wires it to the realtime feed.
 */
export function TopBar({ email, displayName, role, dispensaryName }: TopBarProps): ReactNode {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const initials = computeInitials(displayName, email);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-outline bg-surface px-6">
      <div className="flex items-center gap-2 text-sm">
        {dispensaryName !== undefined ? (
          <span className="inline-flex items-center gap-2 rounded-lg border border-outline bg-surface px-3 py-1.5 text-secondary shadow-sm">
            <Store aria-hidden="true" className="h-3.5 w-3.5 text-moss-600" />
            <span className="font-medium">{dispensaryName}</span>
          </span>
        ) : (
          <span className="text-muted">No dispensary selected</span>
        )}
      </div>
      <div className="hidden flex-1 justify-center md:flex">
        <button
          type="button"
          disabled
          className="group inline-flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-outline bg-surface-muted px-3 text-sm text-muted transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed"
          aria-label="Search (coming in Phase 17)"
        >
          <Search aria-hidden="true" className="h-4 w-4" />
          <span className="flex-1 text-left">Search orders, customers, products…</span>
          <kbd className="hidden rounded-md border border-outline bg-surface px-1.5 py-0.5 text-2xs font-medium text-muted md:inline-block">
            ⌘K
          </kbd>
        </button>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled
          aria-label="Notifications (coming in Phase 17)"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-subtle hover:text-secondary disabled:cursor-not-allowed"
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-surface-subtle"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(): void => {
              setOpen((prev) => !prev);
            }}
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-moss-500 text-xs font-semibold text-on-primary shadow-sm"
            >
              {initials}
            </span>
            <span className="hidden flex-col items-start leading-tight md:flex">
              <span className="font-medium text-foreground">{displayName ?? email}</span>
              <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                {role}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'hidden h-3.5 w-3.5 text-muted transition-transform duration-150 md:block',
                open && 'rotate-180',
              )}
            />
          </button>
          {open && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 origin-top-right animate-slide-down overflow-hidden rounded-xl border border-outline bg-surface py-1 shadow-lg"
            >
              <div className="border-b border-outline-subtle px-4 py-3">
                <p className="truncate text-sm font-medium text-foreground">
                  {displayName ?? 'Signed in'}
                </p>
                <p className="truncate text-xs text-muted">{email}</p>
              </div>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-secondary transition-colors hover:bg-surface-muted"
                onClick={(): void => {
                  void signOut({ callbackUrl: '/login' });
                }}
              >
                <LogOut aria-hidden="true" className="h-4 w-4 text-muted" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function computeInitials(displayName: string | null, email: string): string {
  if (displayName !== null) {
    const parts = displayName.trim().split(/\s+/u);
    if (parts.length >= 2) {
      const first = parts[0]?.[0] ?? '';
      const last = parts[parts.length - 1]?.[0] ?? '';
      const combined = `${first}${last}`.toUpperCase();
      if (combined.length > 0) return combined;
    }
    const single = parts[0]?.slice(0, 2).toUpperCase() ?? '';
    if (single.length > 0) return single;
  }
  return email.slice(0, 2).toUpperCase();
}
