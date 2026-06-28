import { type Metadata, type Viewport } from 'next';
import { type ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'DankDash Checkout',
  description: 'Securely complete your DankDash order.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f1410',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
