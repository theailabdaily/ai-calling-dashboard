'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { LayoutDashboard, Users, Phone, Bot, Send, Clock, RefreshCw, ScrollText, CalendarDays, Search, Shuffle, LogOut, Shield } from 'lucide-react';
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

// Desktop sidebar. Hidden on viewports below lg (1024px) — those use MobileNav.
// On the BDA lookup hostname (ai-lookup.vercel.app), the root layout skips
// rendering this component entirely via the x-is-lookup-host header check,
// so no pathname-based suppression is needed here.
export default function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const email = session?.user?.email;

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

      <ProductLineSwitcher />

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

      <div className="border-t border-white/10">
        <Link
          href="/admin/login-activity"
          className={cn(
            'flex items-center gap-3 px-4 py-2.5 text-sm transition-colors',
            pathname === '/admin/login-activity'
              ? 'bg-brand-pink/20 text-white'
              : 'text-white/60 hover:bg-white/5 hover:text-white',
          )}
        >
          <Shield size={14} />
          Login activity
        </Link>
      </div>

      {email && (
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-medium uppercase shrink-0">
              {email.split('@')[0].slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-white/80 truncate" title={email}>
                {email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center justify-center gap-2 px-2 py-1.5 bg-white/5 hover:bg-white/10 rounded text-[11px] text-white/70 hover:text-white transition-colors"
          >
            <LogOut size={11} />
            Sign out
          </button>
        </div>
      )}

      <div className="p-3 border-t border-white/10 text-[10px] text-white/30">
        <div className="flex items-center gap-1.5">
          <RefreshCw size={10} className="animate-spin" style={{ animationDuration: '4s' }} />
          Auto-refresh 60s
        </div>
      </div>
    </aside>
  );
}
