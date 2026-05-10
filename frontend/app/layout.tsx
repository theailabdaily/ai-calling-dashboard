import type { Metadata, Viewport } from 'next';
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
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen flex">
            {/* Desktop sidebar — hidden below lg AND on /lookup routes */}
            <Sidebar />

            {/* Mobile-only top bar with hamburger; null on lg+ AND on /lookup */}
            <MobileNav />

            {/* Wrapper applies mobile-nav padding only when the mobile nav is rendered */}
            <MainContent>{children}</MainContent>
          </div>
        </Providers>
      </body>
    </html>
  );
}
