import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form.js';

const signIn = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    signIn.mockReset();
    replace.mockReset();
    refresh.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an empty email before calling signIn', async () => {
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Password'), 'super-secret');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/email/iu);
  });

  it('signs in and navigates on success', async () => {
    signIn.mockResolvedValue({ ok: true, error: undefined });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/orders" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'avery@dankdash.com');
    await user.type(screen.getByLabelText('Password'), 'super-secret');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(signIn).toHaveBeenCalledWith('credentials', {
      mode: 'password',
      email: 'avery@dankdash.com',
      password: 'super-secret',
      redirect: false,
    });
    expect(replace).toHaveBeenCalledWith('/orders');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('moves to the MFA step only when the API signals mfa_required', async () => {
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_required', ok: false });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'avery@dankdash.com');
    await user.type(screen.getByLabelText('Password'), 'super-secret');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Authenticator code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a generic error (and does NOT move to MFA) when credentials are wrong', async () => {
    // No `code` on the result — Auth.js's default for a null `authorize`
    // return. This is the wrong-password / unknown-email path.
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'credentials', ok: false });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'jake.mpls@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-pw');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/email or password/iu);
    // Still on the password step — no auth-code field rendered.
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('submits the MFA code on the second leg', async () => {
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_required', ok: false });
    signIn.mockResolvedValueOnce({ ok: true, error: undefined });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'avery@dankdash.com');
    await user.type(screen.getByLabelText('Password'), 'super-secret');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const codeInput = await screen.findByLabelText('Authenticator code');
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(signIn).toHaveBeenNthCalledWith(2, 'credentials', {
      mode: 'mfa',
      email: 'avery@dankdash.com',
      password: 'super-secret',
      mfaCode: '123456',
      redirect: false,
    });
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('rejects a non-numeric MFA code', async () => {
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_required', ok: false });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'a@x.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const codeInput = await screen.findByLabelText('Authenticator code');
    await user.type(codeInput, 'abcdef');
    // input strips non-digits on change — so the value should be empty.
    expect((codeInput as HTMLInputElement).value).toBe('');
  });

  it('lets the user back out of MFA to fix their email/password', async () => {
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_required', ok: false });
    const user = userEvent.setup();
    render(<LoginForm callbackUrl="/dashboard" initialError={null} />);

    await user.type(screen.getByLabelText('Email'), 'a@x.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByLabelText('Authenticator code');
    await user.click(screen.getByRole('button', { name: /back to email/iu }));

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('humanizes the initial error code', () => {
    render(<LoginForm callbackUrl="/dashboard" initialError="CredentialsSignin" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/email or password/iu);
  });

  it('shows a generic error for unrecognized error codes', () => {
    render(<LoginForm callbackUrl="/dashboard" initialError="Mystery" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/went wrong/iu);
  });
});
