import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { auth } from '../../../auth.js';
import { SettingsNav } from '../../../components/shell/settings-nav.js';

/**
 * Two-column settings shell: the left rail mirrors SETTINGS_NAV (store /
 * integrations / compliance) and the right pane renders the active sub-page.
 *
 * The dashboard layout above us has already gated unauthenticated users; this
 * layer enforces the manager+ role gate that matches the nav definition. We
 * redirect rather than 403 so a wrong-role direct link feels like a missing
 * page instead of an access error.
 */
export default async function SettingsLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }
  const role = session.user.role;
  if (role === 'budtender') {
    redirect('/dashboard');
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">
          Configure your store, integrations, and compliance posture.
        </p>
      </header>
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside>
          <SettingsNav role={role} />
        </aside>
        <section>{children}</section>
      </div>
    </div>
  );
}
