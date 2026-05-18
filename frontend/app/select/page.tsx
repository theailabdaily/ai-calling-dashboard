'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, setActiveProductLine, fmt } from '@/lib/api';
import type { ProductLineCard } from '@/types';

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diffMin = Math.floor((Date.now() - t) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

function statusPill(status: ProductLineCard['status']) {
  if (status === 'live') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-50 text-green-800">
        live
      </span>
    );
  }
  if (status === 'idle') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-800">
        idle
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-100 text-surface-500">
      not started
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

// Tint pair per product line slug — used for the icon tile. We don't trust
// arbitrary hex from the DB, so map slugs to a known palette and fall back.
const TINTS: Record<string, { bg: string; fg: string }> = {
  'ugc-net': { bg: '#FBEAF0', fg: '#993556' },
  'upsc':    { bg: '#E6F1FB', fg: '#0C447C' },
  // future:
  'banking': { bg: '#EAF3DE', fg: '#3B6D11' },
  'ctet':    { bg: '#FAEEDA', fg: '#854F0B' },
};
function tintFor(slug: string) {
  return TINTS[slug] ?? { bg: 'var(--color-background-secondary, #f4f4f5)', fg: 'var(--color-text-secondary, #555)' };
}

export default function SelectPage() {
  const router = useRouter();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['product-lines'],
    queryFn: api.productLines,
  });

  function pick(slug: string) {
    setActiveProductLine(slug);
    router.push('/');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 p-4">
      <div className="w-full max-w-[640px]">
        <header className="text-center mb-8">
          <p className="text-xs uppercase tracking-wider text-surface-500 mb-2">
            AI Calling Analytics
          </p>
          <h1 className="text-2xl font-semibold text-brand-navy">Welcome</h1>
          <p className="text-sm text-surface-500 mt-1.5">
            Pick a product line to enter its dashboard
          </p>
        </header>

        {isLoading && (
          <div className="text-center text-sm text-surface-500 py-12">Loading product lines…</div>
        )}

        {isError && (
          <div className="text-center text-sm text-red-600 py-12">
            Could not load product lines. Refresh the page or check your connection.
          </div>
        )}

        {data && data.length === 0 && (
          <div className="text-center text-sm text-surface-500 py-12">
            No product lines configured yet. Ask an admin to set one up.
          </div>
        )}

        {data && data.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {data.map(pl => {
              const tint = tintFor(pl.slug);
              return (
                <button
                  key={pl.slug}
                  type="button"
                  onClick={() => pick(pl.slug)}
                  className="text-left card hover:border-surface-300 transition-colors p-5"
                  aria-label={`Open ${pl.name} dashboard`}
                >
                  <div className="flex items-start justify-between mb-3.5">
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-9 h-9 rounded-md flex items-center justify-center font-medium text-sm"
                        style={{ background: tint.bg, color: tint.fg }}
                      >
                        {initials(pl.name)}
                      </div>
                      <div>
                        <p className="text-[15px] font-medium text-brand-navy leading-tight">
                          {pl.name}
                        </p>
                        <p className="text-xs text-surface-500 mt-0.5">
                          {pl.agent_count} {pl.agent_count === 1 ? 'agent' : 'agents'}
                        </p>
                      </div>
                    </div>
                    {statusPill(pl.status)}
                  </div>

                  {pl.description && (
                    <p className="text-[13px] text-surface-500 leading-relaxed mb-3.5">
                      {pl.description}
                    </p>
                  )}

                  <div className="grid grid-cols-3 gap-2 pt-2.5 pb-2 border-t border-surface-100">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-surface-400">Calls</p>
                      <p className={`text-[15px] font-medium mt-0.5 ${pl.total_calls === 0 ? 'text-surface-400' : ''}`}>
                        {pl.total_calls === 0 ? '—' : fmt.int(pl.total_calls)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-surface-400">Campaigns</p>
                      <p className={`text-[15px] font-medium mt-0.5 ${pl.total_campaigns === 0 ? 'text-surface-400' : ''}`}>
                        {pl.total_campaigns === 0 ? '—' : pl.total_campaigns}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-surface-400">Last call</p>
                      <p className={`text-[15px] font-medium mt-0.5 ${!pl.last_call_at ? 'text-surface-400' : ''}`}>
                        {relativeTime(pl.last_call_at)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-surface-400">
                      {pl.status === 'not_started'
                        ? 'Ready when you trigger first campaign'
                        : pl.status === 'live'
                        ? 'Active in the last 24h'
                        : 'No calls in the last 24h'}
                    </span>
                    <span className="text-[13px] font-medium text-brand-navy">Open →</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="text-center mt-7">
          <p className="text-[11px] text-surface-400">
            🔒 Sign-in restricted to <code className="px-1 py-0.5 bg-surface-100 rounded text-[11px]">@testbook.com</code> Google accounts
          </p>
        </div>
      </div>
    </div>
  );
}
