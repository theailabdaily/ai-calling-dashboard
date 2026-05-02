'use client';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import {
  Search, Volume2, ChevronLeft, ChevronRight, Star, AlertCircle,
  ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

import FilterBar from '@/components/filters/filter-bar';
import InsightsPanel from '@/components/ui/insights-panel';
import CallDetailDrawer from '@/components/calls/call-detail-drawer';
import { StatusBadge } from '@/components/ui/badge';
import { api, fmt } from '@/lib/api';
import { callsInsights } from '@/lib/insights';
import type { Filters } from '@/types';

type SortKey = 'when' | 'duration' | 'status';
type SortOrder = 'asc' | 'desc';

const STATUS_OPTIONS = [
  { value: '',              label: 'All statuses' },
  { value: 'COMPLETED',     label: 'Completed' },
  { value: 'NOT_CONNECTED', label: 'Not connected' },
  { value: 'FAILED',        label: 'Failed' },
  { value: 'IN_PROGRESS',   label: 'In progress' },
  { value: 'SCHEDULED',     label: 'Scheduled' },
  { value: 'CANCELLED',     label: 'Cancelled' },
];

const PICKUP_OPTIONS = [
  { value: '',        label: 'Any pickup' },
  { value: 'HUMAN',   label: 'Human' },
  { value: 'MACHINE', label: 'Voicemail / machine' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

function defaultFilters(): Filters {
  return {
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    end: new Date(),
    vendor_ids: [],
    campaign_ids: [],
  };
}

function filtersFromUrl(sp: URLSearchParams): Filters {
  const base = defaultFilters();
  const startStr = sp.get('start');
  const endStr = sp.get('end');
  if (startStr) {
    const d = new Date(startStr);
    if (!isNaN(d.getTime())) base.start = d;
  }
  if (endStr) {
    const d = new Date(endStr);
    if (!isNaN(d.getTime())) base.end = d;
  }
  return base;
}

// Sortable column header — clickable, shows arrow indicator
function SortHeader({
  label, sortKey, currentKey, currentOrder, onSort, align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentOrder: SortOrder;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = currentKey === sortKey;
  const Icon = isActive ? (currentOrder === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={
        'flex items-center gap-1 text-xs uppercase tracking-wider font-medium hover:text-brand-pink transition-colors ' +
        (align === 'right' ? 'ml-auto' : '') +
        (isActive ? ' text-brand-navy' : ' text-surface-500')
      }
    >
      {label}
      <Icon size={12} className={isActive ? 'text-brand-pink' : 'text-surface-400'} />
    </button>
  );
}

function CallsPageInner() {
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<Filters>(() =>
    filtersFromUrl(new URLSearchParams(searchParams.toString()))
  );
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [onlyRecording, setOnlyRecording] = useState(false);
  const [onlyInterested, setOnlyInterested] = useState(searchParams.get('only_interested') === 'true');
  const [failedOnly, setFailedOnly] = useState(searchParams.get('failed_only') === 'true');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [pickupFilter, setPickupFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortKey>('when');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  useEffect(() => {
    setOnlyInterested(searchParams.get('only_interested') === 'true');
    setFailedOnly(searchParams.get('failed_only') === 'true');
    setFilters(filtersFromUrl(new URLSearchParams(searchParams.toString())));
    setPage(1);
  }, [searchParams]);

  if (search !== debouncedSearch) {
    setTimeout(() => setDebouncedSearch(search), 300);
  }

  // When sorting by a different column, default to a sensible order
  const handleSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      // Newest-first / longest-first / status A-Z
      setSortOrder(key === 'status' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const calls = useQuery({
    queryKey: ['calls', filters, debouncedSearch, page, onlyRecording, onlyInterested, failedOnly, statusFilter, pickupFilter, sortBy, sortOrder],
    queryFn: () => api.callsList({
      f: filters,
      page,
      page_size: 50,
      search: debouncedSearch || undefined,
      only_with_recording: onlyRecording,
      only_interested: onlyInterested,
      failed_only: failedOnly,
      status: statusFilter || undefined,
      answered_by: pickupFilter || undefined,
      sort_by: sortBy,
      sort_order: sortOrder,
    }),
  });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const insights = callsInsights(calls.data);

  const totalPages = calls.data ? Math.max(1, Math.ceil(calls.data.total / calls.data.page_size)) : 1;

  const activeDeepFilter =
    failedOnly ? { label: 'Failed calls only', clear: () => setFailedOnly(false) } :
    onlyInterested ? { label: 'Interested calls only', clear: () => setOnlyInterested(false) } :
    null;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Call logs</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          QA the AI agent. Search by phone or name, filter by outcome, tap any row to inspect.
        </p>
      </header>

      {activeDeepFilter && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 md:px-4 py-2 md:py-2.5 flex items-center gap-2 text-xs md:text-sm">
          <AlertCircle size={14} className="text-amber-600 shrink-0" />
          <span className="text-amber-900 flex-1">
            Filtered to: <strong>{activeDeepFilter.label}</strong>
          </span>
          <button
            onClick={activeDeepFilter.clear}
            className="text-xs text-amber-700 hover:text-amber-900 font-medium underline"
          >
            Clear filter
          </button>
        </div>
      )}

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      <InsightsPanel insights={insights} subtitle="Patterns from the calls visible right now" />

      {/* Search + filter row 1 */}
      <div className="card p-3 md:p-4 flex flex-wrap items-center gap-2 md:gap-3">
        <div className="relative flex-1 min-w-full sm:min-w-[260px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or phone…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-surface-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30 focus:border-brand-pink"
          />
        </div>

        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={pickupFilter}
          onChange={e => { setPickupFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {PICKUP_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

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
        <button
          onClick={() => { setFailedOnly(v => !v); setPage(1); }}
          className={failedOnly ? 'btn bg-amber-600 text-white' : 'btn-outline'}
        >
          <AlertCircle size={14} /> Failed only
        </button>
      </div>

      {/* Result count + sort indicator */}
      <div className="flex items-center justify-between text-xs text-surface-500 px-1">
        <span>
          {calls.data ? `${fmt.int(calls.data.total)} calls` : '—'}
          {' · '}
          Sorted by <strong className="text-surface-700">{sortBy}</strong> ({sortOrder})
        </span>
        {(statusFilter || pickupFilter) && (
          <button
            onClick={() => { setStatusFilter(''); setPickupFilter(''); setPage(1); }}
            className="text-brand-pink hover:underline"
          >
            Clear status & pickup filters
          </button>
        )}
      </div>

      {/* Mobile: card-per-row */}
      <div className="md:hidden space-y-2">
        {(calls.data?.items || []).map(c => (
          <button
            key={c.id}
            onClick={() => setSelectedCallId(c.id)}
            className="card p-3 w-full text-left active:bg-surface-50 transition-colors"
          >
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-brand-navy text-sm truncate">{c.callee_name || '—'}</div>
                <div className="text-xs text-surface-500 tabular-nums">{c.mobile_number || ''}</div>
              </div>
              <StatusBadge status={c.lifecycle_status} />
            </div>
            <div className="flex items-center justify-between text-xs text-surface-500">
              <span>{c.started_at ? formatDistanceToNow(new Date(c.started_at), { addSuffix: true }) : '—'}</span>
              <span className="tabular-nums">{c.duration_seconds ? fmt.duration(c.duration_seconds) : '—'}</span>
            </div>
            {(c.interested || c.follow_up_at || c.has_recording) && (
              <div className="mt-1.5 flex items-center gap-2 flex-wrap text-xs">
                {c.interested && (
                  <span className="text-emerald-700 font-medium">Interest: {c.interested}</span>
                )}
                {c.follow_up_at && !c.interested && (
                  <span className="text-brand-pink font-medium">Callback: {c.follow_up_at}</span>
                )}
                {c.has_recording && <Volume2 size={12} className="text-brand-pink" />}
              </div>
            )}
            <div className="mt-1.5 text-[11px] text-surface-400 truncate">
              {c.vendor_name}{c.agent_name ? ` · ${c.agent_name}` : ''}
            </div>
          </button>
        ))}
        {!calls.data?.items.length && !calls.isLoading && (
          <div className="card p-8 text-center text-sm text-surface-500">
            No calls match these filters.
          </div>
        )}

        {/* Mobile pagination */}
        <div className="flex items-center justify-between pt-1 px-1 text-xs">
          <span className="text-surface-500">Page {page} of {totalPages}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-outline px-3 py-1.5 disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="btn-outline px-3 py-1.5 disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Desktop: full table — hidden below md */}
      <div className="card overflow-hidden hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left bg-surface-50">
                <th className="px-5 py-3">
                  <SortHeader label="When" sortKey="when" currentKey={sortBy} currentOrder={sortOrder} onSort={handleSort} />
                </th>
                <th className="px-3 py-3 text-xs uppercase tracking-wider font-medium text-surface-500">Callee</th>
                <th className="px-3 py-3 text-xs uppercase tracking-wider font-medium text-surface-500">Vendor / Agent</th>
                <th className="px-3 py-3">
                  <SortHeader label="Status" sortKey="status" currentKey={sortBy} currentOrder={sortOrder} onSort={handleSort} />
                </th>
                <th className="px-3 py-3 text-xs uppercase tracking-wider font-medium text-surface-500">Pickup</th>
                <th className="px-3 py-3 text-right">
                  <SortHeader label="Duration" sortKey="duration" currentKey={sortBy} currentOrder={sortOrder} onSort={handleSort} align="right" />
                </th>
                <th className="px-3 py-3 text-xs uppercase tracking-wider font-medium text-surface-500">Outcome</th>
                <th className="px-5 py-3" />
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
                  No calls match these filters. Try widening the date range or clearing filters.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

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

function CallsPageSkeleton() {
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Call logs</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">Loading…</p>
      </header>
      <div className="card p-4 h-16 animate-pulse bg-surface-100" />
      <div className="card p-4 h-32 animate-pulse bg-surface-100" />
      <div className="card p-4 h-96 animate-pulse bg-surface-100" />
    </div>
  );
}

export default function CallsPage() {
  return (
    <Suspense fallback={<CallsPageSkeleton />}>
      <CallsPageInner />
    </Suspense>
  );
}
