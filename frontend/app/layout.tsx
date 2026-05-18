import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from './providers';
import Sidebar from '@/components/layout/sidebar';
import MobileNav from '@/components/layout/mobile-nav';
import MainContent from '@/components/layout/main-content';

export const metadata: Metadata = {
  title: 'AI Calling Analytics — Testbook Supercoaching',
  description: 'Unified analytics across AI calling vendors',
  // Next.js auto-emits the right <link rel="..."> tags from this block.
  // Files live in /frontend/public so they're served at the site root.
  // SVG favicon scales to any DPI without bloating the bundle; PNG and
  // apple-touch are fallbacks for browsers that don't support SVG favicons
  // (Safari <13, older Edge).
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: '/favicon.svg',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#0F0E22',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Middleware sets x-is-lookup-host: 1 on requests coming from the
  // lookup hostname. We use that to skip sidebar/mobile-nav entirely so
  // BDAs see a standalone tool, not the analytics dashboard.
  // Similarly:
  //   x-is-picker: 1 on /select  → picker is full-screen, no sidebar
  //   x-is-login:  1 on /login   → login is full-screen, no sidebar
  const h = headers();
  const isLookupHost = h.get('x-is-lookup-host') === '1';
  const isPicker = h.get('x-is-picker') === '1';
  const isLogin = h.get('x-is-login') === '1';
  const hideShell = isLookupHost || isPicker || isLogin;

  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen flex">
            {!hideShell && <Sidebar />}
            {!hideShell && <MobileNav />}
            <MainContent>{children}</MainContent>
          </div>
        </Providers>
      </body>
    </html>
  );
}
