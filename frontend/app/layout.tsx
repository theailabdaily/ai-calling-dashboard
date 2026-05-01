import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import Sidebar from '@/components/layout/sidebar';

export const metadata: Metadata = {
  title: 'AI Calling Analytics — Testbook Supercoaching',
  description: 'Unified analytics across AI calling vendors',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="min-h-screen flex">
            <Sidebar />
            <main className="flex-1 min-w-0">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
