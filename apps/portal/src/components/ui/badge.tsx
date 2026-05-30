import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Pill badge for status/category labels. Tone maps to an intent; all
 * tones source colors from `@dankdash/design-tokens` semantic palette
 * (base + soft pair), so a tone change in the design tokens flows here
 * automatically:
 *
 *   neutral  — surface-subtle / secondary text
 *   accent   — moss soft / moss text, brand-positive (active, in-progress)
 *   success  — semantic.success filled, completed/healthy
 *   warning  — warning-soft / warning text, slowing/needs-attention
 *   danger   — danger-soft / danger text, behind/failed/error
 *   info     — info-soft / info text, neutral informational
 *
 * Badges are intentionally low-saturation; the visual loudness comes
 * from typography weight, not color intensity, so a dashboard with
 * many of them still feels calm.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-surface-subtle text-secondary',
  accent: 'bg-moss-50 text-moss-700 ring-1 ring-inset ring-moss-100',
  success: 'bg-success text-on-primary',
  warning: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning/20',
  danger: 'bg-danger-soft text-danger ring-1 ring-inset ring-danger/20',
  info: 'bg-info-soft text-info ring-1 ring-inset ring-info/20',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
  readonly icon?: ReactNode;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', icon, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'text-xs font-medium tracking-tight',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon !== undefined ? <span className="flex h-3 w-3 items-center">{icon}</span> : null}
      {children}
    </span>
  );
});
