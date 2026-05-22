import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900',
        'placeholder:text-slate-400',
        'transition-shadow duration-150 ease-out',
        'focus:border-moss-500 focus:outline-none focus:ring-4 focus:ring-moss-500/15',
        'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
        className,
      )}
      {...rest}
    />
  );
});
