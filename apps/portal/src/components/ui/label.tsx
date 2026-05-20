import { type LabelHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, ...rest },
  ref,
) {
  return (
    <label
      ref={ref}
      className={cn('block text-sm font-medium text-slate-700', className)}
      {...rest}
    />
  );
});
