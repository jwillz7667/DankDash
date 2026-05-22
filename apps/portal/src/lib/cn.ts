/**
 * `cn(...classes)` — shadcn-style classname composer. Filters falsy
 * inputs and merges Tailwind classes so `cn('p-2', condition && 'p-4')`
 * keeps the later `p-4` (rather than emitting both, which Tailwind
 * resolves by source-order alphabetically — unpredictable for
 * authors).
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
