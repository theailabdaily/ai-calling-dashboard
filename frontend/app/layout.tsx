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
  const isLookupHost = headers().get('x-is-lookup-host') === '1';

  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen flex">
            {!isLookupHost && <Sidebar />}
            {!isLookupHost && <MobileNav />}
            <MainContent>{children}</MainContent>
          </div>
        </Providers>
      </body>
    </html>
  );
}
