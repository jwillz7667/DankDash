import Image from 'next/image';
import { type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export type LogoVariant = 'mark' | 'wordmark' | 'full';

export interface LogoProps {
  readonly variant?: LogoVariant;
  /**
   * Visual height in px. Width scales from the SVG viewBox. The
   * underlying `<Image>` is `priority` so the brand never paints late
   * — it's part of the first frame on every authenticated route.
   */
  readonly height?: number;
  readonly className?: string;
  /**
   * Optional explicit alt text. Defaults to "DankDash" since the
   * wordmark itself is what readers see. Use empty string for purely
   * decorative placements (e.g. next to a "DankDash" wordmark in
   * surrounding text).
   */
  readonly alt?: string;
}

const VARIANT: Record<
  LogoVariant,
  { readonly src: string; readonly viewBox: readonly [number, number] }
> = {
  mark: { src: '/brand/logo-mark.svg', viewBox: [64, 64] },
  wordmark: { src: '/brand/logo-wordmark.svg', viewBox: [220, 40] },
  full: { src: '/brand/logo-full.svg', viewBox: [280, 64] },
};

export function Logo({
  variant = 'full',
  height = 32,
  className,
  alt = 'DankDash',
}: LogoProps): ReactNode {
  const { src, viewBox } = VARIANT[variant];
  const [w, h] = viewBox;
  const width = Math.round((height * w) / h);
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      priority
      className={cn('select-none', className)}
    />
  );
}
