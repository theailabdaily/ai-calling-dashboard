'use client';
import { useQuery } from '@tanstack/react-query';
import { Search, Volume2, ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

import FilterBar from '@/components/filters/filter-bar';
import InsightsPanel from '@/components/ui/insights-panel';
import CallDetailDrawer from '@/components/calls/call-detail-drawer';
import { StatusBadge } from '@/components/ui/badge';
import { api, fmt } from '@/lib/api';
import { callsInsights } from '@/lib/insights';
import type { Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

export default function CallsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [onlyRecording, setOnlyRecording] = useState(false);
  const [onlyInterested, setOnlyInterested] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  // Debounce search
  if (search !== debouncedSearch) {
    setTimeout(() => setDebouncedSearch(search), 300);
  }

  const calls = useQuery({
    queryKey: ['calls', filters, debouncedSearch, page, onlyRecording, onlyInterested],
    queryFn: () => api.callsList({
      f: filters,
      page,
      page_size: 50,
      search: debouncedSearch || undefined,
      only_with_recording: onlyRecording,
      only_interested: onlyInterested,
    }),
  });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const insights = callsInsights(calls.data);

  const totalPages = calls.data ? Math.max(1, Math.ceil(calls.data.total / calls.data.page_size)) : 1;

  return (
    <div className="p-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Call logs</h1>
        <p className="text-sm text-surface-500 mt-1">
          QA the AI agent. Search by phone or name, filter by outcome, click any row to listen.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      <InsightsPanel insights={insights} subtitle="Patterns from the calls visible right now" />

      {/* Search + toggles row */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or phone…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-surface-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30 focus:border-brand-pink"
          />
        </div>

        <button
          onClick={() => { setOnlyRecording(v => !v); setPage(1); }}
          className={onlyRecording ? 'btn bg-brand-navy text-white' : 'btn-outline'}
        >
          <Volume2 size={14} /> With recording
        </button>
        <button
          onClick={() => { setOnlyInterested(v => !v); setPage(1); }}
          className={onlyInterested ? 'btn bg-brand-pink text-white' : 'btn-outline'}
        >
          <Star size={14} /> Interested only
        </button>

        <span className="text-xs text-surface-500 ml-auto">
          {calls.data ? `${fmt.int(calls.data.total)} calls` : '—'}
        </span>
      </div>

      {/* Calls table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">Callee</th>
                <th className="px-3 py-3 font-medium">Vendor / Agent</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Pickup</th>
                <th className="px-3 py-3 font-medium text-right">Duration</th>
                <th className="px-3 py-3 font-medium">Outcome</th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(calls.data?.items || []).map(c => (
                <tr
                  key={c.id}
                  onClick={() => setSelectedCallId(c.id)}
                  className="border-t border-surface-100 hover:bg-surface-50 cursor-pointer"
                >
                  <td className="px-5 py-3 text-xs text-surface-500 whitespace-nowrap">
                    {c.started_at ? formatDistanceToNow(new Date(c.started_at), { addSuffix: true }) : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-brand-navy">{c.callee_name || '—'}</div>
                    <div className="text-xs text-surface-500 tabular-nums">{c.mobile_number || ''}</div>
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <div className="text-brand-navy font-medium">{c.vendor_name}</div>
                    <div className="text-surface-500 truncate max-w-[180px]">{c.agent_name || '—'}</div>
                  </td>
                  <td className="px-3 py-3"><StatusBadge status={c.lifecycle_status} /></td>
                  <td className="px-3 py-3 text-xs text-surface-700">{c.answered_by.toLowerCase()}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-sm">
                    {c.duration_seconds ? fmt.duration(c.duration_seconds) : '—'}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {c.interested && (
                      <span className="text-emerald-700 font-medium">Interest: {c.interested}</span>
                    )}
                    {c.follow_up_at && !c.interested && (
                      <span className="text-brand-pink font-medium">Callback: {c.follow_up_at}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {c.has_recording && <Volume2 size={14} className="text-brand-pink inline" />}
                  </td>
                </tr>
              ))}
              {!calls.data?.items.length && !calls.isLoading && (
                <tr><td colSpan={8} className="text-center py-12 text-surface-500 text-sm">
                  No calls match these filters. Try widening the date range or running a sync.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-5 py-3 border-t border-surface-200 flex items-center justify-between text-xs">
          <span className="text-surface-500">
            Page {page} of {totalPages}
          </span>
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
      </div>

      <CallDetailDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
    </div>
  );
}
