'use client';
import { useQuery } from '@tanstack/react-query';
import { X, Download, ChevronLeft, ChevronRight, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

import { api, fmt } from '@/lib/api';
import { StatusBadge } from '@/components/ui/badge';
import type { Filters } from '@/types';
import type { FunnelStageKey } from '@/components/charts/funnel';

type Props = {
  filters: Filters;
  stage: FunnelStageKey | null;
  stageLabel: string;
  onClose: () => void;
  onCallClick?: (callId: string) => void;
};

export default function FunnelStageDrawer({ filters, stage, stageLabel, onClose, onCallClick }: Props) {
  const [page, setPage] = useState(1);

  const calls = useQuery({
    queryKey: ['funnel-stage-calls', stage, filters, page],
    queryFn: () => api.callsList({
      f: filters,
      page,
      page_size: 50,
      funnel_stage: stage || undefined,
    }),
    enabled: !!stage,
  });

  if (!stage) return null;

  const totalPages = calls.data ? Math.max(1, Math.ceil(calls.data.total / calls.data.page_size)) : 1;

  // Build export URL with funnel_stage param
  const exportUrl = api.exportCallsUrl(filters, stage);

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} className="fixed inset-0 bg-brand-ink/40 backdrop-blur-sm z-40" />

      {/* Drawer */}
      <aside className="fixed right-0 top-0 h-screen w-full max-w-3xl bg-surface-50 z-50 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-surface-200 px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-center justify-between gap-2 z-10">
          <div>
            <div className="text-xs text-surface-500 uppercase tracking-wider">Funnel stage</div>
            <h2 className="text-base md:text-lg font-semibold text-brand-navy">{stageLabel}</h2>
            <div className="text-xs text-surface-500 mt-0.5">
              {filters.start.toLocaleDateString('en-IN')} → {filters.end.toLocaleDateString('en-IN')}
              {calls.data && <span className="ml-2">· {fmt.int(calls.data.total)} calls</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={exportUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-outline"
            >
              <Download size={14} /> Export CSV
            </a>
            <button onClick={onClose} className="btn-ghost p-2">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-4">
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-3 py-3 font-medium">Callee</th>
                    <th className="px-3 py-3 font-medium">Vendor / Agent</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium text-right">Duration</th>
                    <th className="px-3 py-3 font-medium">Outcome</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {(calls.data?.items || []).map(c => (
                    <tr
                      key={c.id}
                      onClick={() => onCallClick?.(c.id)}
                      className={
                        'border-t border-surface-100 hover:bg-surface-50 ' +
                        (onCallClick ? 'cursor-pointer' : '')
                      }
                    >
                      <td className="px-4 py-3 text-xs text-surface-500 whitespace-nowrap">
                        {c.started_at ? formatDistanceToNow(new Date(c.started_at), { addSuffix: true }) : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-brand-navy text-sm">{c.callee_name || '—'}</div>
                        <div className="text-xs text-surface-500 tabular-nums">{c.mobile_number || ''}</div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <div className="text-brand-navy font-medium">{c.vendor_name}</div>
                        <div className="text-surface-500 truncate max-w-[140px]">{c.agent_name || '—'}</div>
                      </td>
                      <td className="px-3 py-3"><StatusBadge status={c.lifecycle_status} /></td>
                      <td className="px-3 py-3 text-right tabular-nums text-sm">
                        {c.duration_seconds ? fmt.duration(c.duration_seconds) : '—'}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {c.interested && (
                          <span className="text-emerald-700 font-medium">Interest: {c.interested}</span>
                        )}
                        {c.follow_up_at && (
                          <div className="text-brand-pink">Callback: {c.follow_up_at}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {c.has_recording && <Volume2 size={14} className="text-brand-pink inline" />}
                      </td>
                    </tr>
                  ))}
                  {!calls.data?.items.length && !calls.isLoading && (
                    <tr><td colSpan={7} className="text-center py-12 text-surface-500 text-sm">
                      No calls in this stage for the selected window.
                    </td></tr>
                  )}
                  {calls.isLoading && (
                    <tr><td colSpan={7} className="text-center py-12 text-surface-500 text-sm">Loading…</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {calls.data && calls.data.total > calls.data.page_size && (
              <div className="px-4 py-3 border-t border-surface-200 flex items-center justify-between text-xs">
                <span className="text-surface-500">Page {page} of {totalPages}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn-outline px-2 py-1 disabled:opacity-40"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="btn-outline px-2 py-1 disabled:opacity-40"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
