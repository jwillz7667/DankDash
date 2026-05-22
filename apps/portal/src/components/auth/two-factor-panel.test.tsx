import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoFactorPanel } from './two-factor-panel.js';

const update = vi.fn();
const signOut = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => signOut(...args),
  useSession: () => ({ update, status: 'authenticated', data: null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));

describe('TwoFactorPanel', () => {
  beforeEach(() => {
    update.mockReset();
    signOut.mockReset();
    replace.mockReset();
    refresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a non-6-digit code before calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<TwoFactorPanel email="manager@dankdash.com" />);

    await user.type(screen.getByLabelText('6-digit code'), '123');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/6-digit/iu);
  });

  it('verifies the code, updates the session, and routes to /dashboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    update.mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<TwoFactorPanel email="manager@dankdash.com" />);

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/portal/mfa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(update).toHaveBeenCalledWith({ mfaRequired: false, user: { mfaEnabled: true } });
    expect(replace).toHaveBeenCalledWith('/dashboard');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API error message on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'MFA_CODE_INVALID', message: 'Code did not match.', details: {} },
        }),
        { status: 401 },
      ),
    );

    const user = userEvent.setup();
    render(<TwoFactorPanel email="manager@dankdash.com" />);

    await user.type(screen.getByLabelText('6-digit code'), '999999');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Code did not match.');
    expect(update).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error envelope is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 500 }));

    const user = userEvent.setup();
    render(<TwoFactorPanel email="manager@dankdash.com" />);

    await user.type(screen.getByLabelText('6-digit code'), '111111');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/didn.?t match/iu);
  });

  it('triggers signOut from the footer button', async () => {
    const user = userEvent.setup();
    render(<TwoFactorPanel email="manager@dankdash.com" />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});
