import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Buttons.
 *
 *   primary — moss-500 filled; the call-to-action on every page.
 *   secondary — slate border on white, slate text; the every-day action.
 *   ghost — no border, no fill; subordinate actions inside cards.
 *   danger — ember; destructive, used sparingly.
 *
 * Sizes follow our 8-px rhythm: sm=32, md=40, lg=44. The lg button is
 * intentionally only 4px taller than md (not 12) so dense forms don't
 * end up with conspicuously tall primary CTAs.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-moss-500 text-white shadow-sm hover:bg-moss-600 active:bg-moss-700 focus-visible:ring-moss-500',
  secondary:
    'bg-white text-slate-800 border border-slate-200 shadow-sm hover:bg-slate-50 hover:border-slate-300 active:bg-slate-100 focus-visible:ring-moss-500',
  ghost:
    'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 focus-visible:ring-moss-500',
  danger:
    'bg-ember text-white shadow-sm hover:brightness-110 active:brightness-95 focus-visible:ring-ember',
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
        'inline-flex items-center justify-center rounded-lg font-medium tracking-tight',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  );
});
