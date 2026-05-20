import { type ReactNode } from 'react';

/**
 * Layout shared by `/login` and `/two-factor`. No sidebar, no nav —
 * the user is mid-handshake; the entire viewport belongs to the
 * credential form. White canvas with a barely-visible moss radial
 * wash anchored at the top so the page feels intentional without
 * pulling focus from the form.
 */
export default function AuthLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-white p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,_rgba(60,147,34,0.08)_0%,_rgba(255,255,255,0)_70%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-moss-200 to-transparent"
      />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
