'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Phone, Bot, Send, Clock, Menu, X,
} from 'lucide-react';
import { cn } from '@/lib/api';

// Same nav items as desktop Sidebar — kept duplicated here so each component
// stays self-contained for its viewport (avoids cross-component prop drilling
// for a 6-item static list).
const NAV = [
  { href: '/',                label: 'Overview',          icon: LayoutDashboard },
  { href: '/hourly-insights', label: 'Hourly Insights',   icon: Clock },
  { href: '/vendors',         label: 'Vendor Analysis',   icon: Users },
  { href: '/agents',          label: 'Agent Performance', icon: Bot },
  { href: '/calls',           label: 'Call Logs',         icon: Phone },
  { href: '/campaigns/new',   label: 'Launch Campaign',   icon: Send },
];

// Mobile-only nav: a fixed top bar with hamburger + logo, plus a slide-in
// drawer when the hamburger is tapped. Hidden on lg+ where the desktop
// Sidebar takes over.
export default function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close drawer when route changes (the user just tapped a nav item)
  useEffect(() => { setOpen(false); }, [pathname]);

  // Lock body scroll while drawer is open so the page underneath doesn't
  // scroll along with the drawer's swipe gestures.
  useEffect(() => {
    if (open) {
      const orig = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = orig; };
    }
  }, [open]);

  // Esc key closes the drawer (helpful on tablets with keyboards)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Top bar — fixed at top, h-14 (56px), only on mobile */}
      <header className="lg:hidden fixed top-0 left-0 right-0 h-14 bg-black text-white z-30 flex items-center px-4 border-b border-white/10">
        <button
          onClick={() => setOpen(true)}
          className="p-2 -ml-2 rounded-lg hover:bg-white/10 active:bg-white/20 transition-colors"
          aria-label="Open menu"
        >
          <Menu size={22} />
        </button>
        <div className="ml-2 flex items-center gap-2">
          <Image
            src="/logo-light.png"
            alt="Testbook Supercoaching"
            width={120}
            height={32}
            className="h-7 w-auto"
            priority
          />
          <span className="text-[11px] text-white/50 leading-none border-l border-white/20 pl-2">
            AI Calling
          </span>
        </div>
      </header>

      {/* Backdrop — only when drawer open */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="lg:hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-40 animate-in fade-in duration-150"
          aria-hidden
        />
      )}

      {/* Slide-in drawer — translates from -100% to 0 */}
      <aside
        className={cn(
          'lg:hidden fixed top-0 left-0 h-screen w-[80vw] max-w-[300px] bg-black text-white z-50 flex flex-col',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-hidden={!open}
      >
        <div className="p-5 border-b border-white/10 flex items-center justify-between">
          <Image
            src="/logo-light.png"
            alt="Testbook Supercoaching"
            width={160}
            height={40}
            className="h-10 w-auto"
          />
          <button
            onClick={() => setOpen(false)}
            className="p-2 -mr-2 rounded-lg hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 py-4 px-3 overflow-y-auto">
          {NAV.map(item => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors mb-1',
                  active ? 'bg-brand-pink text-white' : 'text-white/70 hover:bg-white/5 active:bg-white/10',
                )}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10 text-xs text-white/40">
          Auto-refresh: 60s
        </div>
      </aside>
    </>
  );
}
