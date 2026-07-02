'use client';

/**
 * Create form for a dispensary promo code — a slide-over (same overlay
 * structure as ProductEditor). Promo codes are immutable after creation
 * apart from their active flag, so this surface is create-only; the list
 * owns deactivate/reactivate.
 *
 * Money the operator enters in dollars is converted to integer cents with
 * the float-safe `parseInputToCents` before it hits the payload — never a
 * `dollars * 100` multiply. Start/end are entered as local wall-clock and
 * folded to a UTC ISO instant. The server re-validates every field.
 */
import { Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  type CreateVendorPromotionInput,
  type PromoType,
  type VendorPromotion,
} from '../../lib/api/vendor-promotions.js';
import { parseInputToCents } from '../../lib/listings/format.js';
import {
  datetimeLocalToIso,
  isValidPromoCode,
  normalizePromoCode,
  parseOptionalWholeNumber,
  parsePercent,
  promoTypeLabel,
  toDatetimeLocalValue,
} from '../../lib/promotions/format.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import type { VendorPromotionActions } from '../../lib/promotions/promotion-actions.js';

const PROMO_TYPES: readonly PromoType[] = ['percent', 'fixed_amount', 'free_delivery'];
const SELECT_CLASS =
  'h-10 w-full rounded-md border border-outline bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 disabled:opacity-50';

export interface PromotionEditorProps {
  readonly onClose: () => void;
  readonly onCreated: (promo: VendorPromotion) => void;
  readonly actions: Pick<VendorPromotionActions, 'create'>;
  /** Injectable clock so the seeded "starts" default is deterministic in tests. */
  readonly now?: Date;
}

interface FormState {
  code: string;
  type: PromoType;
  percentValue: string;
  amountDollars: string;
  minSubtotalDollars: string;
  maxDiscountDollars: string;
  startsAt: string;
  endsAt: string;
  maxRedemptions: string;
  maxRedemptionsPerUser: string;
}

function seed(now: Date): FormState {
  return {
    code: '',
    type: 'percent',
    percentValue: '',
    amountDollars: '',
    minSubtotalDollars: '',
    maxDiscountDollars: '',
    startsAt: toDatetimeLocalValue(now),
    endsAt: '',
    maxRedemptions: '',
    maxRedemptionsPerUser: '1',
  };
}

interface BuildResult {
  readonly payload?: CreateVendorPromotionInput;
  readonly error?: string;
}

/**
 * Validate the form and assemble the wire payload, or return the first
 * user-facing error. Pure over its inputs so the branching is easy to
 * reason about; the component just renders `error` and calls the action
 * with `payload`.
 */
function buildPayload(form: FormState): BuildResult {
  const code = normalizePromoCode(form.code);
  if (!isValidPromoCode(code)) {
    return { error: 'Code must be 3–40 characters using A–Z, 0–9, and hyphens.' };
  }

  let value: number;
  if (form.type === 'percent') {
    const percent = parsePercent(form.percentValue);
    if (percent === null) return { error: 'Percent must be a whole number from 1 to 100.' };
    value = percent;
  } else if (form.type === 'fixed_amount') {
    const cents = parseInputToCents(form.amountDollars);
    if (cents === null || cents <= 0) return { error: 'Enter a discount amount greater than $0.' };
    value = cents;
  } else {
    value = 0;
  }

  let minSubtotalCents = 0;
  if (form.minSubtotalDollars.trim() !== '') {
    const cents = parseInputToCents(form.minSubtotalDollars);
    if (cents === null) return { error: 'Minimum subtotal must be a dollar amount like 25.00.' };
    minSubtotalCents = cents;
  }

  let maxDiscountCents: number | null = null;
  if (form.type === 'percent' && form.maxDiscountDollars.trim() !== '') {
    const cents = parseInputToCents(form.maxDiscountDollars);
    if (cents === null || cents <= 0) {
      return {
        error: 'Max discount must be a dollar amount greater than $0, or blank for no cap.',
      };
    }
    maxDiscountCents = cents;
  }

  const startsAt = datetimeLocalToIso(form.startsAt);
  if (startsAt === null) return { error: 'Choose a start date and time.' };

  let endsAt: string | null = null;
  if (form.endsAt.trim() !== '') {
    endsAt = datetimeLocalToIso(form.endsAt);
    if (endsAt === null) return { error: 'The end date is invalid.' };
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      return { error: 'The end date must be after the start date.' };
    }
  }

  const maxRedemptions = parseOptionalWholeNumber(form.maxRedemptions);
  if (maxRedemptions === undefined) {
    return { error: 'Total redemption limit must be a whole number, or blank for unlimited.' };
  }

  const perUser = parseOptionalWholeNumber(form.maxRedemptionsPerUser);
  if (perUser === undefined || perUser === null || perUser < 1) {
    return { error: 'Per-customer limit must be a whole number of at least 1.' };
  }

  return {
    payload: {
      code,
      type: form.type,
      value,
      minSubtotalCents,
      ...(form.type === 'percent' ? { maxDiscountCents } : {}),
      startsAt,
      endsAt,
      maxRedemptions,
      maxRedemptionsPerUser: perUser,
    },
  };
}

export function PromotionEditor({
  onClose,
  onCreated,
  actions,
  now,
}: PromotionEditorProps): ReactNode {
  const [form, setForm] = useState<FormState>(() => seed(now ?? new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const set = useCallback(<K extends keyof FormState>(key: K, val: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: val }));
  }, []);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const built = buildPayload(form);
    if (built.payload === undefined) {
      setError(built.error ?? 'Check the fields and retry.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await actions.create(built.payload);
      onCreated(created);
      onClose();
    } catch (err) {
      setError(extractMessage(err, "Couldn't create the promo code. Check the fields and retry."));
    } finally {
      setBusy(false);
    }
  }, [actions, form, onClose, onCreated]);

  const isPercent = form.type === 'percent';
  const isFixed = form.type === 'fixed_amount';

  return (
    <div className="fixed inset-0 z-40" data-testid="promotion-editor-root">
      <button
        type="button"
        className="absolute inset-0 bg-surface-inverse/40 backdrop-blur-sm"
        aria-label="Close promo editor"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="promotion-editor-title"
        data-testid="promotion-editor"
        className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-outline bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-outline px-6 py-4">
          <h2 id="promotion-editor-title" className="text-lg font-semibold text-foreground">
            New promo code
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label="Code">
            <Input
              value={form.code}
              onChange={(e) => {
                set('code', normalizePromoCode(e.target.value));
              }}
              disabled={busy}
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="SUMMER10"
            />
          </Field>

          <Field label="Discount type">
            <select
              value={form.type}
              onChange={(e) => {
                set('type', e.target.value as PromoType);
              }}
              disabled={busy}
              className={SELECT_CLASS}
              data-testid="promotion-editor-type"
            >
              {PROMO_TYPES.map((t) => (
                <option key={t} value={t}>
                  {promoTypeLabel(t)}
                </option>
              ))}
            </select>
          </Field>

          {isPercent ? (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Percent off (%)">
                <Input
                  value={form.percentValue}
                  onChange={(e) => {
                    set('percentValue', e.target.value);
                  }}
                  disabled={busy}
                  inputMode="numeric"
                  placeholder="10"
                />
              </Field>
              <Field label="Max discount ($, optional)">
                <Input
                  value={form.maxDiscountDollars}
                  onChange={(e) => {
                    set('maxDiscountDollars', e.target.value);
                  }}
                  disabled={busy}
                  inputMode="decimal"
                  placeholder="No cap"
                />
              </Field>
            </div>
          ) : null}

          {isFixed ? (
            <Field label="Amount off ($)">
              <Input
                value={form.amountDollars}
                onChange={(e) => {
                  set('amountDollars', e.target.value);
                }}
                disabled={busy}
                inputMode="decimal"
                placeholder="5.00"
              />
            </Field>
          ) : null}

          {form.type === 'free_delivery' ? (
            <p className="rounded-md border border-info/30 bg-info-soft px-3 py-2 text-xs text-info">
              Waives the delivery fee at checkout. No discount value to set.
            </p>
          ) : null}

          <Field label="Minimum subtotal ($, optional)">
            <Input
              value={form.minSubtotalDollars}
              onChange={(e) => {
                set('minSubtotalDollars', e.target.value);
              }}
              disabled={busy}
              inputMode="decimal"
              placeholder="No minimum"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Starts">
              <Input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => {
                  set('startsAt', e.target.value);
                }}
                disabled={busy}
              />
            </Field>
            <Field label="Ends (optional)">
              <Input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => {
                  set('endsAt', e.target.value);
                }}
                disabled={busy}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Total redemptions (optional)">
              <Input
                value={form.maxRedemptions}
                onChange={(e) => {
                  set('maxRedemptions', e.target.value);
                }}
                disabled={busy}
                inputMode="numeric"
                placeholder="Unlimited"
              />
            </Field>
            <Field label="Per customer">
              <Input
                value={form.maxRedemptionsPerUser}
                onChange={(e) => {
                  set('maxRedemptionsPerUser', e.target.value);
                }}
                disabled={busy}
                inputMode="numeric"
                placeholder="1"
              />
            </Field>
          </div>

          {error !== null ? (
            <p
              role="alert"
              className="text-sm font-medium text-danger"
              data-testid="promotion-editor-error"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline bg-surface-muted/40 px-6 py-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={busy}
            data-testid="promotion-editor-save"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
            Create promo code
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  // Wrap the control in the <label> so it's associated for assistive tech (and
  // getByLabelText) without threading a generated id through every input.
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}
