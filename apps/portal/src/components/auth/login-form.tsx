'use client';

/**
 * Login form. Two-step credential collection:
 *
 *   step='password' — email + password. On submit calls
 *   `signIn('credentials', { mode: 'password', ... })`. If the API
 *   responds `mfa_required`, our Auth.js authorize() throws
 *   `MfaRequiredError` (code='mfa_required'); we surface that here
 *   as a `setStep('mfa')` so the user enters the TOTP without a
 *   page hop. Any other error (wrong password, unknown email,
 *   non-portal role) collapses to a generic message — Auth.js
 *   converts a null `authorize()` return into a credentials error
 *   without a code, which is exactly the "don't leak which field
 *   was wrong" property we want for those cases.
 *
 *   step='mfa' — 6-digit TOTP. On submit re-calls `signIn` with
 *   mode='mfa' and the same credentials. Auth.js writes the session
 *   cookie + redirects to `callbackUrl` on success.
 *
 * We probe the MFA gate by calling the credentials provider with
 * `redirect: false` and inspecting `result.code` for the
 * `mfa_required` sentinel the authorize() throw plants there.
 */
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

export interface LoginFormProps {
  readonly callbackUrl: string;
  readonly initialError: string | null;
}

const EmailSchema = z.string().trim().toLowerCase().email();
const PasswordSchema = z.string().min(1, 'Password is required');
const MfaCodeSchema = z
  .string()
  .regex(/^\d{6}$/u, 'Enter the 6-digit code from your authenticator.');

type Step = 'password' | 'mfa';

export function LoginForm({ callbackUrl, initialError }: LoginFormProps): ReactNode {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(humanizeError(initialError));

  const handleSubmit = async (): Promise<void> => {
    setError(null);

    if (step === 'password') {
      const parsedEmail = EmailSchema.safeParse(email);
      if (!parsedEmail.success) {
        setError(parsedEmail.error.issues[0]?.message ?? 'Email is required.');
        return;
      }
      const parsedPassword = PasswordSchema.safeParse(password);
      if (!parsedPassword.success) {
        setError(parsedPassword.error.issues[0]?.message ?? 'Password is required.');
        return;
      }

      setPending(true);
      const result = await signIn('credentials', {
        mode: 'password',
        email: parsedEmail.data,
        password: parsedPassword.data,
        redirect: false,
      });
      setPending(false);

      if (result === undefined) {
        setError('Unexpected response from sign-in. Please try again.');
        return;
      }
      if (result.error === undefined) {
        // Success — session cookie set. Move to the callback URL.
        router.replace(callbackUrl);
        router.refresh();
        return;
      }
      if (result.code === 'mfa_required') {
        // authorize() threw MfaRequiredError — the password was right
        // but the account has a TOTP enrolled. Render the code input.
        setStep('mfa');
        setError(null);
        return;
      }
      // Anything else — wrong password, unknown email, non-portal role —
      // collapses to a generic message. We deliberately do not tell the
      // user which field was wrong.
      setError('That email or password didn’t match. Try again.');
      return;
    }

    const parsedCode = MfaCodeSchema.safeParse(mfaCode);
    if (!parsedCode.success) {
      setError(parsedCode.error.issues[0]?.message ?? 'Invalid code.');
      return;
    }

    setPending(true);
    const result = await signIn('credentials', {
      mode: 'mfa',
      email,
      password,
      mfaCode: parsedCode.data,
      redirect: false,
    });
    setPending(false);

    if (result === undefined) {
      setError('Unexpected response from sign-in. Please try again.');
      return;
    }
    if (result.error === undefined) {
      router.replace(callbackUrl);
      router.refresh();
      return;
    }
    setError('That email, password, or code didn’t match. Try again.');
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event): void => {
        event.preventDefault();
        void handleSubmit();
      }}
      noValidate
    >
      {step === 'password' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(event): void => {
                setEmail(event.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event): void => {
                setPassword(event.target.value);
              }}
            />
          </div>
        </>
      )}

      {step === 'mfa' && (
        <div className="space-y-1.5">
          <Label htmlFor="mfaCode">Authenticator code</Label>
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
            value={mfaCode}
            onChange={(event): void => {
              setMfaCode(event.target.value.replace(/\D/gu, ''));
            }}
          />
          <p className="text-xs text-slate-500">
            Enter the 6-digit code from your authenticator app.
          </p>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : step === 'password' ? 'Continue' : 'Sign in'}
      </Button>

      {step === 'mfa' && (
        <button
          type="button"
          className="block w-full text-center text-xs font-medium text-slate-500 hover:text-moss-700"
          onClick={(): void => {
            setStep('password');
            setMfaCode('');
            setError(null);
          }}
        >
          ← Back to email + password
        </button>
      )}
    </form>
  );
}

function humanizeError(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case 'CredentialsSignin':
      return 'That email or password didn’t match. Try again.';
    case 'AccessDenied':
      return 'This account isn’t allowed in the vendor portal.';
    case 'SessionRequired':
      return 'Please sign in to continue.';
    default:
      return 'Something went wrong signing you in. Please try again.';
  }
}
