'use client';

/**
 * Payout bank-account panel. Shows whether the dispensary has a linked
 * Aeropay bank account (the destination for daily payouts) and offers a
 * link / relink CTA.
 *
 * Clicking "Link"/"Relink" calls the `startLink` server action, which mints
 * an Aeropay hosted-flow URL, then hands the browser off to that URL. The
 * operator completes linking on Aeropay's page and is redirected back to
 * `returnUrl`; a `bank_account.linked` webhook then persists the confirmed
 * account server-side, so on return the refreshed page shows "Linked".
 *
 * The return URL is derived from the current origin at click time so the
 * component stays agnostic of the deployment host and no URL travels through
 * server-rendered props.
 */
import { Landmark, Loader2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api/client.js';
import { redirectTo } from '../../lib/browser/navigate.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardBody } from '../ui/card.js';
import type { PayoutBankActions } from '../../lib/payouts/payouts-actions.js';

export interface BankAccountPanelProps {
  readonly linked: boolean;
  readonly actions: PayoutBankActions;
}

export function BankAccountPanel({ linked, actions }: BankAccountPanelProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLink = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const returnUrl = `${window.location.origin}/payouts`;
      const result = await actions.startLink(returnUrl);
      // Hand off to Aeropay's hosted flow. No `finally` reset of `busy` — we
      // are leaving the page, and keeping the button disabled prevents a
      // double-tap from minting a second session during the redirect.
      redirectTo(result.link.hostedUrl);
    } catch (err) {
      setError(extractError(err));
      setBusy(false);
    }
  }, [actions]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <Landmark aria-hidden="true" className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                Payout bank account
              </h2>
              <Badge tone={linked ? 'success' : 'warning'}>
                {linked ? 'Linked' : 'Not linked'}
              </Badge>
            </div>
            <p className="text-sm text-muted">
              {linked
                ? 'Daily payouts settle to your linked Aeropay bank account. Relink if you need to change the destination.'
                : 'Link an Aeropay bank account to receive daily payouts. Until then, payouts are held.'}
            </p>
            {error !== null ? (
              <p role="alert" className="mt-1 text-xs font-medium text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          variant={linked ? 'secondary' : 'primary'}
          onClick={() => {
            void handleLink();
          }}
          disabled={busy}
          className="sm:flex-none"
          data-testid="bank-link-button"
        >
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Starting…
            </>
          ) : linked ? (
            'Relink bank account'
          ) : (
            'Link bank account'
          )}
        </Button>
      </CardBody>
    </Card>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to manage payout banking.";
    if (err.status === 422) return err.envelope?.error.message ?? 'That request was rejected.';
    if (err.status === 503) return 'Bank linking is temporarily unavailable. Try again shortly.';
  }
  return "Couldn't start bank linking. Try again.";
}
