'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Phone, Bot, Send, Clock, RefreshCw, ScrollText, CalendarDays, Search } from 'lucide-react';
import { cn } from '@/lib/api';

const NAV = [
  { href: '/',                label: 'Overview',          icon: LayoutDashboard },
  { href: '/hourly-insights', label: 'Hourly Insights',   icon: Clock },
  { href: '/dod-leads',       label: 'Leads',             icon: CalendarDays },
  { href: '/vendors',         label: 'Vendor Analysis',   icon: Users },
  { href: '/agents',          label: 'Agent Performance', icon: Bot },
  { href: '/calls',           label: 'Call Logs',         icon: Phone },
  { href: '/lookup',          label: 'Lookup (For BD)',   icon: Search },
  { href: '/ledger',          label: 'Activity Log',      icon: ScrollText },
  { href: '/campaigns/new',   label: 'Launch Campaign',   icon: Send },
];

// Desktop sidebar. Hidden on viewports below lg (1024px) — those use MobileNav.
// On the BDA lookup hostname (ai-lookup.vercel.app), the root layout skips
// rendering this component entirely via the x-is-lookup-host header check,
// so no pathname-based suppression is needed here.
export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden lg:flex w-64 shrink-0 bg-black text-white min-h-screen flex-col sticky top-0 h-screen">
      <div className="p-5 border-b border-white/10">
        <Image
          src="/logo-light.png"
          alt="Testbook Supercoaching"
          width={180}
          height={48}
          className="h-12 w-auto"
          priority
        />
        <p className="text-xs text-white/60 mt-3 leading-tight">AI Calling Analytics</p>
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
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors mb-1',
                active ? 'bg-brand-pink text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
              )}
            >
              <Icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-white/10 text-xs text-white/40">
        <div className="flex items-center gap-2">
          <RefreshCw size={12} className="animate-spin" style={{ animationDuration: '4s' }} />
          Auto-refresh: 60s
        </div>
      </div>
    </aside>
  );
}
