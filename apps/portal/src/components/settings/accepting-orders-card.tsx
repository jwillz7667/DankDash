'use client';

/**
 * "Accepting orders" toggle. The single biggest day-to-day setting:
 * flipping it off pauses new orders without affecting in-flight ones,
 * which is what an operator needs when they're slammed or short-staffed.
 *
 * Optimistic — flips the visual state immediately, reconciles with the
 * server response. On failure, we roll back the local view and surface
 * the error.
 */
import { Loader2, Pause, Play } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api/client.js';
import { Button } from '../ui/button.js';
import { Card, CardBody } from '../ui/card.js';
import type { VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';

export interface AcceptingOrdersCardProps {
  readonly isAcceptingOrders: boolean;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
}

export function AcceptingOrdersCard({
  isAcceptingOrders,
  onPatch,
  onPatched,
}: AcceptingOrdersCardProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const updated = await onPatch({ isAcceptingOrders: !isAcceptingOrders });
      onPatched(updated);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }, [isAcceptingOrders, onPatch, onPatched]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div
            className={
              isAcceptingOrders
                ? 'flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-moss-50 text-moss-700'
                : 'flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-warning-soft text-warning'
            }
          >
            {isAcceptingOrders ? (
              <Play aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Pause aria-hidden="true" className="h-4 w-4" />
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {isAcceptingOrders ? 'Accepting orders' : 'Paused'}
            </h2>
            <p className="text-sm text-muted">
              {isAcceptingOrders
                ? 'Customers can place orders right now. Pause if you need to stop intake without ending an in-flight queue.'
                : "No new orders are being accepted. In-flight orders continue normally. Resume when you're ready."}
            </p>
            {error !== null ? (
              <p role="alert" className="mt-1 text-xs font-medium text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          variant={isAcceptingOrders ? 'secondary' : 'primary'}
          onClick={() => {
            void handleToggle();
          }}
          disabled={busy}
          className="sm:flex-none"
          data-testid="accepting-orders-toggle"
        >
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : isAcceptingOrders ? (
            'Pause intake'
          ) : (
            'Resume intake'
          )}
        </Button>
      </CardBody>
    </Card>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to change intake.";
    if (err.status === 422) return err.envelope?.error.message ?? 'That change was rejected.';
  }
  return "Couldn't save. Try again.";
}
