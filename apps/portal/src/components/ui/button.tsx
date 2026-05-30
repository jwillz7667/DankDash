import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Buttons. All variants pull from `@dankdash/design-tokens` aliases —
 * primary/moss-500, surface/outline tokens for the neutral chrome,
 * ember for danger. Radius is `rounded-xl` (12 pt, matches DankRadius.md
 * on iOS) so primary CTAs look the same across portal + consumer + dasher.
 *
 *   primary   — moss-500 filled; the call-to-action on every page.
 *   secondary — outline border on surface; the every-day action.
 *   ghost     — no border, no fill; subordinate actions inside cards.
 *   danger    — ember; destructive, used sparingly.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-moss-500 text-on-primary shadow-sm hover:bg-moss-600 active:bg-moss-700 focus-visible:ring-moss-500',
  secondary:
    'bg-surface text-foreground border border-outline shadow-sm hover:bg-surface-muted hover:border-outline-strong active:bg-surface-subtle focus-visible:ring-moss-500',
  ghost:
    'bg-transparent text-secondary hover:bg-surface-subtle active:bg-outline focus-visible:ring-moss-500',
  danger:
    'bg-ember text-on-primary shadow-sm hover:brightness-110 active:brightness-95 focus-visible:ring-ember',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex items-center justify-center rounded-xl font-medium tracking-tight',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  );
});
