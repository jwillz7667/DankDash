'use client';

import { useEffect, useRef } from 'react';
import { type ReactNode } from 'react';

/**
 * Auto-submits the hand-off exchange once on mount, with a visible button as
 * the progressive-enhancement fallback when JS is unavailable. The exchange
 * itself is the server action (`startCheckout`) — this only triggers it. The
 * `submitted` ref guards against React strict-mode's double mount firing two
 * submits (the action is also idempotent server-side as a backstop).
 */
export function StartForm({
  handoff,
  action,
}: {
  handoff: string;
  action: (formData: FormData) => void | Promise<void>;
}): ReactNode {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    formRef.current?.requestSubmit();
  }, []);

  return (
    <form ref={formRef} action={action}>
      <input type="hidden" name="handoff" value={handoff} />
      <div className="spinner" aria-hidden="true" />
      <noscript>
        <p className="sub center">Tap continue to load your order.</p>
      </noscript>
      <button type="submit" className="btn btn-primary">
        Continue
      </button>
    </form>
  );
}
