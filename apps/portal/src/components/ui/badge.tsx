import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Pill badge for status/category labels. Tone maps to an intent:
 *
 *   neutral  — slate, "no opinion"
 *   accent   — moss, brand-positive (active, in-progress)
 *   success  — moss-deep filled, completed/healthy
 *   warning  — amber, slowing/needs-attention
 *   danger   — ember, behind/failed/error
 *   info     — sky, neutral informational (counts, hints)
 *
 * Badges are intentionally low-saturation; the visual loudness comes
 * from typography weight, not color intensity, so a dashboard with
 * many of them still feels calm.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  accent: 'bg-moss-50 text-moss-700 ring-1 ring-inset ring-moss-100',
  success: 'bg-moss-500 text-white',
  warning: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-100',
  danger: 'bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-100',
  info: 'bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-100',
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
