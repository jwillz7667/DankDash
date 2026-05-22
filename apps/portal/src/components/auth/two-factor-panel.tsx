'use client';

/**
 * Two-factor enrollment surface.
 *
 * Phase 13 ships the shell — instructions and a "verify code" form.
 * The full TOTP enrollment flow (calling /v1/auth/mfa/setup to fetch
 * the secret + QR code, then /v1/auth/mfa/confirm with the user's
 * first valid code) lands behind a server action in this file when
 * the portal-to-API session bridge is finalized.
 *
 * The form here calls /v1/auth/mfa/verify against the API via the
 * portal's own session, then triggers `session.update()` so middleware
 * sees `mfaRequired: false` on the next render.
 */
import { useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

export interface TwoFactorPanelProps {
  readonly email: string;
}

const MfaCodeSchema = z
  .string()
  .regex(/^\d{6}$/u, 'Enter the 6-digit code from your authenticator.');

export function TwoFactorPanel({ email }: TwoFactorPanelProps): ReactNode {
  const router = useRouter();
  const { update } = useSession();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    setInfo(null);
    const parsed = MfaCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid code.');
      return;
    }
    setPending(true);
    try {
      const response = await fetch('/api/portal/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: parsed.data }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'That code didn’t match. Please try again.');
        return;
      }
      await update({ mfaRequired: false, user: { mfaEnabled: true } });
      setInfo('Two-factor verified. Redirecting…');
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <ol className="space-y-2.5 text-sm text-slate-600">
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-moss-50 text-2xs font-semibold text-moss-700">
            1
          </span>
          <span>Install an authenticator app (1Password, Authy, or Google Authenticator).</span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-moss-50 text-2xs font-semibold text-moss-700">
            2
          </span>
          <span>
            Scan the QR code on your enrollment screen, or enter the setup key your store manager
            provided.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-moss-50 text-2xs font-semibold text-moss-700">
            3
          </span>
          <span>Enter the current 6-digit code below to confirm enrollment.</span>
        </li>
      </ol>
      <form
        onSubmit={(event): void => {
          event.preventDefault();
          void handleSubmit();
        }}
        noValidate
        className="space-y-3"
      >
        <div className="space-y-1.5">
          <Label htmlFor="mfaCode">6-digit code</Label>
          <Input
            id="mfaCode"
            name="mfaCode"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            required
            className="text-center font-tabular text-lg tracking-[0.4em]"
            value={code}
            onChange={(event): void => {
              setCode(event.target.value.replace(/\D/gu, ''));
            }}
          />
        </div>
        {error !== null && (
          <p
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {error}
          </p>
        )}
        {info !== null && (
          <p className="rounded-lg border border-moss-200 bg-moss-50 px-3 py-2 text-sm text-moss-800">
            {info}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <div className="flex items-center justify-between border-t border-slate-100 pt-4 text-xs text-slate-500">
        <span>
          Signed in as <span className="font-medium text-slate-700">{email}</span>
        </span>
        <button
          type="button"
          className="font-medium text-moss-700 hover:text-moss-800"
          onClick={(): void => {
            void signOut({ callbackUrl: '/login' });
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
