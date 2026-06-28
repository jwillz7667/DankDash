'use client';

import { useState } from 'react';
import { type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import {
  formatCents,
  MAX_DELIVERY_INSTRUCTIONS,
  tipDollarsToCents,
  TIP_PRESETS_CENTS,
} from '@/lib/format';

function SubmitButton({ totalCents }: { totalCents: number }): ReactNode {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? 'Placing order…' : `Place order · ${formatCents(totalCents)}`}
    </button>
  );
}

/**
 * Tip selection + delivery note + submit. The driver tip is mandatory ($2
 * floor) and pre-paid; the selected value rides through a hidden field as
 * integer cents and the server re-validates it. The displayed total is the
 * items subtotal plus tip — taxes and delivery are added server-side at
 * checkout, called out in the page fineprint.
 */
export function ReviewForm({
  subtotalCents,
  action,
}: {
  subtotalCents: number;
  action: (formData: FormData) => void | Promise<void>;
}): ReactNode {
  const [tipCents, setTipCents] = useState<number>(TIP_PRESETS_CENTS[1] ?? 500);
  const [customDollars, setCustomDollars] = useState<string>('');

  function selectPreset(cents: number): void {
    setTipCents(cents);
    setCustomDollars('');
  }

  function onCustom(value: string): void {
    setCustomDollars(value);
    const dollars = Number(value);
    if (value.length > 0 && Number.isFinite(dollars)) {
      setTipCents(tipDollarsToCents(dollars));
    }
  }

  const isCustom = customDollars.length > 0;

  return (
    <form action={action} className="card">
      <h2>Driver tip</h2>
      <div className="tips" role="group" aria-label="Driver tip">
        {TIP_PRESETS_CENTS.map((cents) => (
          <button
            key={cents}
            type="button"
            className="tip-btn"
            aria-pressed={!isCustom && tipCents === cents}
            onClick={() => {
              selectPreset(cents);
            }}
          >
            {formatCents(cents)}
          </button>
        ))}
      </div>

      <label htmlFor="custom-tip">Custom tip (USD)</label>
      <input
        id="custom-tip"
        type="number"
        inputMode="decimal"
        min="2"
        step="0.50"
        placeholder="e.g. 8.00"
        value={customDollars}
        onChange={(e) => {
          onCustom(e.target.value);
        }}
      />

      <label htmlFor="instructions">Delivery instructions (optional)</label>
      <textarea
        id="instructions"
        name="deliveryInstructions"
        maxLength={MAX_DELIVERY_INSTRUCTIONS}
        placeholder="Gate code, building entrance, where to meet…"
      />

      <input type="hidden" name="driverTipCents" value={tipCents} />

      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Subtotal</span>
        <span className="mono muted">{formatCents(subtotalCents)}</span>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">Driver tip</span>
        <span className="mono muted">{formatCents(tipCents)}</span>
      </div>

      <SubmitButton totalCents={subtotalCents + tipCents} />
    </form>
  );
}
