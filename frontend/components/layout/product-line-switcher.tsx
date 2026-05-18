'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Grid3x3 } from 'lucide-react';
import { api, getActiveProductLine, setActiveProductLine } from '@/lib/api';
import type { ProductLineCard } from '@/types';

const TINTS: Record<string, { bg: string; fg: string }> = {
  'ugc-net': { bg: '#FBEAF0', fg: '#993556' },
  'upsc':    { bg: '#E6F1FB', fg: '#0C447C' },
  'banking': { bg: '#EAF3DE', fg: '#3B6D11' },
  'ctet':    { bg: '#FAEEDA', fg: '#854F0B' },
};
function tintFor(slug: string) {
  return TINTS[slug] ?? { bg: 'rgba(255,255,255,0.1)', fg: '#fff' };
}
function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function ProductLineSwitcher() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Hydrate from cookie after mount (SSR has no cookie)
  useEffect(() => {
    setActiveSlug(getActiveProductLine());
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { data } = useQuery({
    queryKey: ['product-lines-switcher'],
    queryFn: api.productLines,
    enabled: open, // Only fetch when user opens dropdown — cheap
    staleTime: 5 * 60 * 1000, // 5 min — these change rarely
  });

  function switchTo(slug: string) {
    setActiveProductLine(slug);
    setOpen(false);
    // Reload current route under new scope. router.refresh() doesn't reset
    // tanstack-query caches, so go through Next's hard navigation.
    window.location.assign(window.location.pathname);
  }

  function backToPicker() {
    setActiveProductLine(null);
    setOpen(false);
    router.push('/select');
  }

  if (!activeSlug) {
    // No scope set — sidebar is being rendered before redirect runs.
    // Don't show anything; the page will redirect to /select shortly.
    return null;
  }

  // Best-effort label even before /api/product-lines responds — slug → Title
  const fallbackName = activeSlug
    .split('-')
    .map(w => w.toUpperCase())
    .join(' ');
  const current = data?.find(pl => pl.slug === activeSlug);
  const name = current?.name ?? fallbackName;
  const tint = tintFor(activeSlug);

  const others = (data ?? []).filter(pl => pl.slug !== activeSlug);

  return (
    <div ref={ref} className="px-3 pt-3 pb-2 relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 bg-white/5 hover:bg-white/10 rounded-md transition-colors text-left"
      >
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center font-medium text-[12px] shrink-0"
          style={{ background: tint.bg, color: tint.fg }}
        >
          {initials(name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-white leading-tight truncate">{name}</p>
          <p className="text-[10px] text-white/50 leading-tight mt-0.5">Current product line</p>
        </div>
        <ChevronDown size={14} className="text-white/60 shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-3 right-3 top-full mt-1 bg-zinc-900 border border-white/10 rounded-md p-1 z-50 shadow-xl"
        >
          {others.length > 0 ? (
            <>
              <p className="text-[10px] uppercase tracking-wider text-white/40 px-2 py-1.5">
                Switch to
              </p>
              {others.map(pl => {
                const t = tintFor(pl.slug);
                return (
                  <button
                    key={pl.slug}
                    type="button"
                    onClick={() => switchTo(pl.slug)}
                    role="menuitem"
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/10 transition-colors"
                  >
                    <div
                      className="w-6 h-6 rounded flex items-center justify-center font-medium text-[11px]"
                      style={{ background: t.bg, color: t.fg }}
                    >
                      {initials(pl.name)}
                    </div>
                    <span className="text-[13px] text-white flex-1">{pl.name}</span>
                    {pl.status === 'not_started' && (
                      <span className="text-[10px] text-white/40">not started</span>
                    )}
                  </button>
                );
              })}
              <div className="h-px bg-white/10 my-1" />
            </>
          ) : data ? (
            <p className="text-[11px] text-white/40 px-2 py-2">No other product lines yet</p>
          ) : (
            <p className="text-[11px] text-white/40 px-2 py-2">Loading…</p>
          )}

          <button
            type="button"
            onClick={backToPicker}
            role="menuitem"
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/10 transition-colors text-white/80"
          >
            <Grid3x3 size={13} />
            <span className="text-[13px]">Back to picker</span>
          </button>
        </div>
      )}
    </div>
  );
}
