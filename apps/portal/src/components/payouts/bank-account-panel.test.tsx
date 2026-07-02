import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client.js';
import { redirectTo } from '../../lib/browser/navigate.js';
import { BankAccountPanel } from './bank-account-panel.js';
import type { StartDispensaryBankLinkResult } from '../../lib/api/vendor-payouts.js';
import type { PayoutBankActions } from '../../lib/payouts/payouts-actions.js';

vi.mock('../../lib/browser/navigate.js', () => ({ redirectTo: vi.fn() }));

const redirectMock = vi.mocked(redirectTo);

const SESSION: StartDispensaryBankLinkResult = {
  link: {
    id: 'link_session_1',
    hostedUrl: 'https://link.aeropay.com/session/1',
    expiresAt: '2026-05-01T03:00:00.000Z',
  },
};

function makeActions(overrides: Partial<PayoutBankActions> = {}): PayoutBankActions {
  return {
    startLink:
      overrides.startLink ??
      ((): Promise<StartDispensaryBankLinkResult> => Promise.resolve(SESSION)),
  };
}

describe('BankAccountPanel', () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it('shows the not-linked state with a link CTA', () => {
    render(<BankAccountPanel linked={false} actions={makeActions()} />);

    expect(screen.getByText('Not linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /link bank account/i })).toBeInTheDocument();
  });

  it('shows the linked state with a relink CTA', () => {
    render(<BankAccountPanel linked actions={makeActions()} />);

    expect(screen.getByText('Linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /relink bank account/i })).toBeInTheDocument();
  });

  it('starts a link session with the current origin and redirects to the hosted URL', async () => {
    const startLink = vi.fn((returnUrl: string): Promise<StartDispensaryBankLinkResult> => {
      expect(returnUrl).toBe(`${window.location.origin}/payouts`);
      return Promise.resolve(SESSION);
    });
    render(<BankAccountPanel linked={false} actions={makeActions({ startLink })} />);

    fireEvent.click(screen.getByTestId('bank-link-button'));

    await waitFor(() => expect(startLink).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(redirectMock).toHaveBeenCalledWith('https://link.aeropay.com/session/1'),
    );
  });

  it('surfaces a 403 error and does not redirect', async () => {
    const err = new ApiError('forbidden', 403, 'forbidden', {
      error: { code: 'forbidden', message: 'nope', details: {} },
    });
    const startLink = vi.fn(() => Promise.reject(err));
    render(<BankAccountPanel linked={false} actions={makeActions({ startLink })} />);

    fireEvent.click(screen.getByTestId('bank-link-button'));

    await screen.findByText(/don't have permission/i);
    expect(redirectMock).not.toHaveBeenCalledWith('https://link.aeropay.com/session/1');
    // Button re-enables after a failure so the operator can retry.
    expect(screen.getByRole('button', { name: /link bank account/i })).toBeEnabled();
  });
});
