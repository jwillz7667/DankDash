import { type ReactNode } from 'react';

/** The DankDash word-mark used at the top of every checkout screen. */
export function Brand(): ReactNode {
  return (
    <div className="brand">
      <span className="brand-dot" aria-hidden="true" />
      <span>DankDash</span>
    </div>
  );
}
