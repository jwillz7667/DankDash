import { type Metadata, type Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { type ReactNode } from 'react';
import { QueryClientProvider } from '../providers/query-client-provider.js';
import './globals.css';

/**
 * Inter — variable, latin only. Loaded as a CSS variable so Tailwind's
 * font-family stack can reach it via `font-sans`. We skip the auto
 * Google fetch in dev (`adjustFontFallback` keeps cumulative-layout-shift
 * down without us hand-tuning a fallback metric).
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/**
 * JetBrains Mono for monospaced surfaces — order IDs, dispensary
 * license numbers, code-shaped UI in compliance.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'DankDash for Business',
    template: '%s · DankDash for Business',
  },
  description: 'Vendor portal for DankDash — orders, inventory, payouts, compliance, analytics.',
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: '/brand/favicon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#FFFFFF',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="h-full bg-white font-sans text-slate-900">
        <QueryClientProvider>{children}</QueryClientProvider>
      </body>
    </html>
  );
}
