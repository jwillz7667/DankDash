import { type HTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn.js';

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-outline bg-surface shadow-sm',
        'transition-shadow duration-200 ease-out',
        className,
      )}
      {...rest}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, CardProps>(function CardHeader(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex items-start justify-between gap-4 border-b border-outline-subtle px-6 py-5',
        className,
      )}
      {...rest}
    />
  );
});

export const CardBody = forwardRef<HTMLDivElement, CardProps>(function CardBody(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn('px-6 py-5', className)} {...rest} />;
});

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...rest }, ref) {
    return (
      <h2
        ref={ref}
        className={cn('text-[15px] font-semibold tracking-tight text-foreground', className)}
        {...rest}
      />
    );
  },
);

export const CardSubtitle = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function CardSubtitle({ className, ...rest }, ref) {
    return <p ref={ref} className={cn('mt-0.5 text-sm text-muted', className)} {...rest} />;
  },
);
