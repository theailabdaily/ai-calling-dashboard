import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import Sidebar from '@/components/layout/sidebar';
import MobileNav from '@/components/layout/mobile-nav';

export const metadata: Metadata = {
  title: 'AI Calling Analytics — Testbook Supercoaching',
  description: 'Unified analytics across AI calling vendors',
};

// Viewport is now its own export in the App Router (Next 14+). This sets the
// proper viewport tag so phones don't render the page at desktop width and
// shrink it down — and it locks the initial scale so iOS Safari doesn't auto-
// zoom on form-input focus.
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
            {/* Desktop sidebar — hidden below lg */}
            <Sidebar />

            {/* Mobile-only top bar with hamburger; renders nothing on lg+ */}
            <MobileNav />

            {/* Push content below the 56px mobile top bar; on lg+ no offset */}
            <main className="flex-1 min-w-0 pt-14 lg:pt-0">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
