import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { auth } from '../../auth.js';
import { Sidebar } from '../../components/shell/sidebar.js';
import { TopBar } from '../../components/shell/top-bar.js';

/**
 * Shell for every authenticated route. Reads the session from
 * Auth.js (server component), redirects to /login if absent, and
 * renders the sidebar + top bar around the page content.
 *
 * Middleware also guards these routes; we duplicate the auth check
 * here so a misconfigured matcher cannot expose page contents
 * accidentally (defense in depth).
 */
export default async function DashboardLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }
  if (session.mfaRequired) {
    redirect('/two-factor');
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Sidebar role={session.user.role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar
          email={session.user.email}
          displayName={session.user.name ?? null}
          role={session.user.role}
        />
        <main className="scrollbar-slim flex-1 overflow-auto bg-surface-muted/40 px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
