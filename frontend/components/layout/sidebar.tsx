'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Users, Phone, Bot, Send, Clock, RefreshCw,
  ScrollText, CalendarDays, Search, Shuffle, Shield,
} from 'lucide-react';
import { cn } from '@/lib/api';
import ProductLineSwitcher from './product-line-switcher';

const NAV = [
  { href: '/',                label: 'Overview',          icon: LayoutDashboard },
  { href: '/dod-leads',       label: 'Leads',             icon: CalendarDays },
  { href: '/calls',           label: 'Call Logs',         icon: Phone },
  { href: '/hourly-insights', label: 'Hourly Insights',   icon: Clock },
  { href: '/ledger',          label: 'Activity Log',      icon: ScrollText },
  { href: '/vendors',         label: 'Vendor Analysis',   icon: Users },
  { href: '/agents',          label: 'Agent Performance', icon: Bot },
  { href: '/campaigns/new',   label: 'Launch Campaign',   icon: Send },
  { href: '/lookup',          label: 'Lookup (For BD)',   icon: Search },
  { href: '/attribution',     label: 'Lead Attribution',  icon: Shuffle },
];

// Desktop sidebar. Hidden below lg (1024px) — mobile uses MobileNav.
// Density philosophy: every row is 32px tall. Logo block sits flush at top,
// nav is one continuous column, user/utility rows pinned bottom.
// On the BDA lookup hostname (ai-lookup.vercel.app), the root layout skips
// rendering this component entirely via the x-is-lookup-host header check.
export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex w-60 shrink-0 bg-black text-white min-h-screen flex-col sticky top-0 h-screen">
      {/* Logo block — clickable, navigates back to Overview (/) */}
      <Link
        href="/"
        className="px-4 pt-4 pb-3 border-b border-white/10 hover:bg-white/[0.02] transition-colors"
      >
        <Image
          src="/logo-light.png"
          alt="Testbook Supercoaching — go to Overview"
          width={160}
          height={40}
          className="h-9 w-auto"
          priority
        />
        <p className="text-[10px] text-white/50 mt-1.5 tracking-wide uppercase">
          AI Calling Analytics
        </p>
      </Link>

      {/* Workspace switcher */}
      <ProductLineSwitcher />

      {/* Primary nav */}
      <nav className="flex-1 px-2 py-2 overflow-y-auto">
        {NAV.map(item => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] transition-colors',
                active
                  ? 'bg-brand-pink text-white font-medium'
                  : 'text-white/65 hover:bg-white/[0.06] hover:text-white',
              )}
            >
              <Icon size={15} strokeWidth={1.75} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Utility row — login activity */}
      <Link
        href="/admin/login-activity"
        className={cn(
          'flex items-center gap-2.5 px-3.5 h-8 mx-2 mb-1 rounded-md text-[12px] transition-colors',
          pathname === '/admin/login-activity'
            ? 'bg-brand-pink/15 text-white'
            : 'text-white/50 hover:bg-white/[0.06] hover:text-white',
        )}
      >
        <Shield size={13} strokeWidth={1.75} />
        Login activity
      </Link>

      {/* Footer — auto-refresh indicator */}
      <div className="px-3 py-2 border-t border-white/5 text-[9px] text-white/25 tracking-wide uppercase">
        <div className="flex items-center gap-1.5">
          <RefreshCw size={9} className="animate-spin" style={{ animationDuration: '4s' }} />
          Auto-refresh 60s
        </div>
      </div>
    </aside>
  );
}
