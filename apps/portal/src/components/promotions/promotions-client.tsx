'use client';

/**
 * Client orchestrator for the Promotions page. Owns the local promo list so
 * create/deactivate/reactivate update the table without a refetch, and drives
 * the PromotionEditor slide-over for authoring a new code.
 *
 * Actions are injected (VendorPromotionActions) so tests run with in-memory
 * fakes — mirrors the products/menu/settings client pattern.
 */
import { Loader2, Plus } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import {
  formatMinSubtotal,
  formatPromoValue,
  formatPromoWindow,
  formatRedemptions,
  promoTypeLabel,
} from '../../lib/promotions/format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { PromotionEditor } from './promotion-editor.js';
import type { VendorPromotion } from '../../lib/api/vendor-promotions.js';
import type { VendorPromotionActions } from '../../lib/promotions/promotion-actions.js';

export interface PromotionsClientProps {
  readonly initialPromotions: readonly VendorPromotion[];
  readonly actions: VendorPromotionActions;
}

export function PromotionsClient({ initialPromotions, actions }: PromotionsClientProps): ReactNode {
  const [promotions, setPromotions] = useState<readonly VendorPromotion[]>(initialPromotions);
  const [editorOpen, setEditorOpen] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreated = useCallback((created: VendorPromotion): void => {
    setPromotions((prev) => [created, ...prev]);
  }, []);

  const upsert = useCallback((updated: VendorPromotion): void => {
    setPromotions((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const handleDeactivate = useCallback(
    async (promo: VendorPromotion): Promise<void> => {
      setMutatingId(promo.id);
      setError(null);
      try {
        await actions.deactivate(promo.id);
        // DELETE returns 204; reflect the deactivation locally without a refetch.
        setPromotions((prev) => prev.map((p) => (p.id === promo.id ? { ...p, active: false } : p)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't deactivate that promo code.");
      } finally {
        setMutatingId(null);
      }
    },
    [actions],
  );

  const handleReactivate = useCallback(
    async (promo: VendorPromotion): Promise<void> => {
      setMutatingId(promo.id);
      setError(null);
      try {
        const updated = await actions.patch(promo.id, { active: true });
        upsert(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't reactivate that promo code.");
      } finally {
        setMutatingId(null);
      }
    },
    [actions, upsert],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Promotions</h1>
          <p className="max-w-2xl text-sm text-muted">
            Create and manage your store's promo codes. Discounts apply at checkout; the server
            enforces every limit, window, and redemption cap.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditorOpen(true);
          }}
          data-testid="promotions-new"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          New promo code
        </Button>
      </header>

      {error !== null ? (
        <p role="alert" className="text-sm font-medium text-danger" data-testid="promotions-error">
          {error}
        </p>
      ) : null}

      {promotions.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-outline bg-surface px-6 py-12 text-center"
        >
          <p className="text-sm font-medium text-secondary">No promo codes yet</p>
          <p className="max-w-md text-sm text-muted">
            Create your first code to run a percentage discount, a fixed amount off, or free
            delivery for your customers.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-outline bg-surface shadow-sm">
          <table className="w-full divide-y divide-outline-subtle text-left text-sm">
            <thead className="bg-surface-muted text-xs font-medium uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Code
                </th>
                <th scope="col" className="px-4 py-3">
                  Type
                </th>
                <th scope="col" className="px-4 py-3">
                  Value
                </th>
                <th scope="col" className="px-4 py-3">
                  Min subtotal
                </th>
                <th scope="col" className="px-4 py-3">
                  Window
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Redemptions
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Per customer
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-subtle" data-testid="promotions-list">
              {promotions.map((promo) => (
                <PromotionRow
                  key={promo.id}
                  promo={promo}
                  busy={mutatingId === promo.id}
                  onDeactivate={() => {
                    void handleDeactivate(promo);
                  }}
                  onReactivate={() => {
                    void handleReactivate(promo);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editorOpen ? (
        <PromotionEditor
          onClose={() => {
            setEditorOpen(false);
          }}
          onCreated={handleCreated}
          actions={actions}
        />
      ) : null}
    </div>
  );
}

function PromotionRow({
  promo,
  busy,
  onDeactivate,
  onReactivate,
}: {
  readonly promo: VendorPromotion;
  readonly busy: boolean;
  readonly onDeactivate: () => void;
  readonly onReactivate: () => void;
}): ReactNode {
  return (
    <tr className="hover:bg-surface-muted" data-testid={`promotions-row-${promo.id}`}>
      <td className="px-4 py-3 font-semibold tracking-tight text-foreground">{promo.code}</td>
      <td className="px-4 py-3 text-secondary">{promoTypeLabel(promo.type)}</td>
      <td className="px-4 py-3 tabular-nums text-secondary">{formatPromoValue(promo)}</td>
      <td className="px-4 py-3 tabular-nums text-muted">
        {formatMinSubtotal(promo.minSubtotalCents)}
      </td>
      <td className="px-4 py-3 text-xs text-muted">
        {formatPromoWindow(promo.startsAt, promo.endsAt)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-secondary">
        {formatRedemptions(promo.redemptionCount, promo.maxRedemptions)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-secondary">
        {String(promo.maxRedemptionsPerUser)}
      </td>
      <td className="px-4 py-3">
        <Badge tone={promo.active ? 'accent' : 'neutral'}>
          {promo.active ? 'Active' : 'Inactive'}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right">
        {promo.active ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onDeactivate}
            aria-label={`Deactivate ${promo.code}`}
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            Deactivate
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onReactivate}
            aria-label={`Reactivate ${promo.code}`}
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            Reactivate
          </Button>
        )}
      </td>
    </tr>
  );
}
