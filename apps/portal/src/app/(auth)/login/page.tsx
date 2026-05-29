import { ArrowUpRight } from 'lucide-react';
import { type Metadata } from 'next';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { LoginForm } from '../../../components/auth/login-form.js';
import { Logo } from '../../../components/brand/logo.js';

export const metadata: Metadata = {
  title: 'Sign in — DankDash for Business',
};

interface LoginPageProps {
  readonly searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps): Promise<ReactNode> {
  const params = await searchParams;
  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-3">
        <Logo variant="mark" height={48} />
        <p className="text-2xs font-semibold uppercase tracking-wider text-moss-700">
          DankDash for Business
        </p>
      </div>
      <div className="rounded-2xl border border-outline bg-surface p-8 shadow-md">
        <header className="mb-6 space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Sign in</h1>
          <p className="text-sm text-muted">
            Use the email and password your dispensary provisioned for you.
          </p>
        </header>
        <LoginForm
          callbackUrl={params.callbackUrl ?? '/dashboard'}
          initialError={params.error ?? null}
        />
      </div>
      <p className="text-center text-xs text-muted">
        Trouble signing in?{' '}
        <Link
          href="mailto:support@dankdash.com"
          className="inline-flex items-center gap-0.5 font-medium text-moss-700 hover:text-moss-800"
        >
          support@dankdash.com
          <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
        </Link>
      </p>
    </div>
  );
}
