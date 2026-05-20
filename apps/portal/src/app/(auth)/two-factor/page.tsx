import { ShieldCheck } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { auth } from '../../../auth.js';
import { TwoFactorPanel } from '../../../components/auth/two-factor-panel.js';
import { Logo } from '../../../components/brand/logo.js';

export const metadata: Metadata = {
  title: 'Two-factor — DankDash for Business',
};

/**
 * Post-login MFA gate. Two cases reach this page:
 *
 *   1. The user is `manager`/`owner`/`admin` and hasn't enrolled yet.
 *      We surface enrollment instructions and a "I've enrolled, take me
 *      back" button.
 *
 *   2. The user already enrolled but the session was minted before
 *      this requirement existed. Same UI — enroll, refresh, proceed.
 *
 * Unauthenticated visitors bounce to /login. Authenticated visitors
 * who do NOT have `mfaRequired` are bounced to /dashboard.
 */
export default async function TwoFactorPage(): Promise<ReactNode> {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }
  if (!session.mfaRequired) {
    redirect('/dashboard');
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-3">
        <Logo variant="mark" height={48} />
        <p className="inline-flex items-center gap-1.5 rounded-full bg-moss-50 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-moss-700">
          <ShieldCheck aria-hidden="true" className="h-3 w-3" />
          Required
        </p>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-md">
        <header className="mb-6 space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Add two-factor authentication
          </h1>
          <p className="text-sm text-slate-500">
            Manager and owner accounts must complete enrollment before continuing. Your account
            <span className="font-medium text-slate-700"> ({session.user.email}) </span>
            has not yet enrolled.
          </p>
        </header>
        <TwoFactorPanel email={session.user.email} />
      </div>
    </div>
  );
}
