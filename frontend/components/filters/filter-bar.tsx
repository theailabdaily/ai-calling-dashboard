'use client';
import { useQuery, useQueryClient, useIsFetching } from '@tanstack/react-query';
import { Calendar, ChevronDown, Download, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Filters } from '@/types';

type PresetKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'ytd' | 'alltime';

const PRESETS: { label: string; key: PresetKey }[] = [
  { label: 'Today',     key: 'today' },
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'Last 7d',   key: 'last7' },
  { label: 'Last 30d',  key: 'last30' },
  { label: 'YTD',       key: 'ytd' },
  { label: 'All time',  key: 'alltime' },
];

// Sentinel "very old" date for the All time preset. Set well before any
// expected ingest history so it captures everything currently in the DB
// and any reasonable future backfill, without using literal Date(0) which
// renders awkwardly in datetime-local inputs.
const ALL_TIME_START = new Date(2020, 0, 1, 0, 0, 0, 0);

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d: Date)   { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

function applyPreset(key: PresetKey): { start: Date; end: Date } {
  const now = new Date();
  switch (key) {
    case 'today': {
      return { start: startOfDay(now), end: endOfDay(now) };
    }
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case 'last7':
    case 'last30': {
      const days = key === 'last7' ? 7 : 30;
      const start = new Date(now); start.setDate(start.getDate() - days);
      return { start: startOfDay(start), end: endOfDay(now) };
    }
    case 'ytd': {
      return { start: new Date(now.getFullYear(), 0, 1), end: endOfDay(now) };
    }
    case 'alltime': {
      // Capture every record in the DB. End is "now to the minute" — using
      // the actual current time rather than end-of-day makes the chart not
      // claim it has data for hours that haven't happened yet.
      return { start: ALL_TIME_START, end: now };
    }
  }
}

// "2026-04-30T15:30" → Date (local); used for <input type="datetime-local">.
// We accept and produce the input's native format so timezone math stays
// consistent with what the user sees in the picker.
function parseInputDateTime(s: string): Date | null {
  if (!s) return null;
  // datetime-local sends "YYYY-MM-DDTHH:mm" (sometimes with seconds)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +(se ?? 0));
}
function toInputDateTime(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day}T${h}:${mi}`;
}

function fmtCampaign(c: { name: string; started_at: string | null; vendor_id: string }, vendorName?: string): string {
  const datePart = c.started_at
    ? new Date(c.started_at).toISOString().slice(0, 10)
    : null;
  const parts = [datePart, vendorName, c.name].filter(Boolean);
  return parts.join(' — ');
}

type Props = {
  filters: Filters;
  onChange: (f: Filters) => void;
  onExport?: () => void;
};

type OpenPopup = 'vendor' | 'campaign' | null;

export default function FilterBar({ filters, onChange, onExport }: Props) {
  const [open, setOpen] = useState<OpenPopup>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Refresh button machinery — invalidates every React Query cache so all
  // tiles, charts, and tables refetch from the API. Doesn't trigger a Hunar
  // sync (that's the GH Actions cron's job, every 10 min). The "Updated Xs
  // ago" affordance tells the user what they're really getting.
  const qc = useQueryClient();
  const fetching = useIsFetching();   // 0 when idle, >0 while any query is in-flight
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [, forceTick] = useState(0);  // re-render every 10s so "Xs ago" stays current
  useEffect(() => {
    const id = setInterval(() => forceTick(n => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  const handleRefresh = () => {
    qc.invalidateQueries();
    setLastRefresh(new Date());
  };
  const secondsAgo = Math.floor((Date.now() - lastRefresh.getTime()) / 1000);
  const updatedLabel =
    secondsAgo < 5     ? 'just now' :
    secondsAgo < 60    ? `${secondsAgo}s ago` :
    secondsAgo < 3600  ? `${Math.floor(secondsAgo / 60)}m ago` :
                         `${Math.floor(secondsAgo / 3600)}h ago`;

  // Outside-click closes whatever popup is open
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const vendors = useQuery({ queryKey: ['vendors'], queryFn: api.vendors });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns });

  const vendorById = new Map((vendors.data || []).map(v => [v.id, v]));

  const visibleCampaigns = (campaigns.data || []).filter(c =>
    filters.vendor_ids.length === 0 || filters.vendor_ids.includes(c.vendor_id)
  );

  const toggle = (id: string, key: 'vendor_ids' | 'campaign_ids') => {
    const set = new Set(filters[key]);
    set.has(id) ? set.delete(id) : set.add(id);
    onChange({ ...filters, [key]: [...set] });
  };

  // Preserve whatever HH:MM the user picks. Previously these forced
  // start→00:00 and end→23:59; now they respect the input verbatim so
  // users can slice by hour-of-day.
  const setStart = (s: string) => {
    const d = parseInputDateTime(s);
    if (d) onChange({ ...filters, start: d });
  };
  const setEnd = (s: string) => {
    const d = parseInputDateTime(s);
    if (d) onChange({ ...filters, end: d });
  };

  return (
    <div ref={containerRef} className="card p-3 md:p-4 flex flex-wrap items-center gap-2 md:gap-3">
      {/* Date range presets */}
      <div className="flex items-center gap-1 flex-wrap">
        <Calendar size={16} className="text-surface-500 mr-1" />
        {PRESETS.map(p => (
          <button
            key={p.key}
            onClick={() => onChange({ ...filters, ...applyPreset(p.key) })}
            className="btn-ghost px-2.5 py-1.5 text-xs"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom range — datetime-local gives a HH:MM picker alongside the
          date picker in one native widget. step="60" hides the seconds field
          (default 1; we don't need second-level precision). */}
      <div className="flex items-center gap-1 text-xs text-surface-600 flex-wrap">
        <input
          type="datetime-local"
          step={60}
          value={toInputDateTime(filters.start)}
          onChange={e => setStart(e.target.value)}
          className="px-2 py-1.5 rounded border border-surface-300 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        />
        <span className="text-surface-400">→</span>
        <input
          type="datetime-local"
          step={60}
          value={toInputDateTime(filters.end)}
          onChange={e => setEnd(e.target.value)}
          className="px-2 py-1.5 rounded border border-surface-300 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        />
      </div>

      <div className="hidden lg:block flex-1" />

      {/* Vendor multi-select */}
      <div className="relative">
        <button
          onClick={() => setOpen(o => (o === 'vendor' ? null : 'vendor'))}
          className="btn-outline"
        >
          Vendors
          {filters.vendor_ids.length > 0 && (
            <span className="pill bg-brand-pink/10 text-brand-pink ml-1">{filters.vendor_ids.length}</span>
          )}
          <ChevronDown size={14} />
        </button>
        {open === 'vendor' && (
          <div className="absolute right-0 sm:right-0 top-full mt-1 w-56 max-w-[calc(100vw-2rem)] card p-2 z-30 shadow-lg">
            {(vendors.data || []).map(v => (
              <label key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.vendor_ids.includes(v.id)}
                  onChange={() => toggle(v.id, 'vendor_ids')}
                  className="accent-brand-pink"
                />
                <span className="text-sm">{v.name}</span>
              </label>
            ))}
            {!vendors.data?.length && <div className="text-xs text-surface-500 p-2">No vendors yet</div>}
            {filters.vendor_ids.length > 0 && (
              <button
                onClick={() => onChange({ ...filters, vendor_ids: [], campaign_ids: [] })}
                className="w-full text-xs text-surface-500 hover:text-brand-pink mt-1 py-1 border-t border-surface-200"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Campaign multi-select */}
      <div className="relative">
        <button
          onClick={() => setOpen(o => (o === 'campaign' ? null : 'campaign'))}
          className="btn-outline"
        >
          Campaigns
          {filters.campaign_ids.length > 0 && (
            <span className="pill bg-brand-pink/10 text-brand-pink ml-1">{filters.campaign_ids.length}</span>
          )}
          <ChevronDown size={14} />
        </button>
        {open === 'campaign' && (
          <div className="absolute right-0 top-full mt-1 w-[28rem] max-w-[calc(100vw-2rem)] card p-2 z-30 max-h-80 overflow-y-auto shadow-lg">
            {visibleCampaigns.map(c => {
              const vendorName = vendorById.get(c.vendor_id)?.name;
              return (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-100 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.campaign_ids.includes(c.id)}
                    onChange={() => toggle(c.id, 'campaign_ids')}
                    className="accent-brand-pink shrink-0"
                  />
                  <span className="text-sm truncate" title={fmtCampaign(c, vendorName)}>
                    {fmtCampaign(c, vendorName)}
                  </span>
                </label>
              );
            })}
            {!visibleCampaigns.length && <div className="text-xs text-surface-500 p-2">No campaigns yet</div>}
            {filters.campaign_ids.length > 0 && (
              <button
                onClick={() => onChange({ ...filters, campaign_ids: [] })}
                className="w-full text-xs text-surface-500 hover:text-brand-pink mt-1 py-1 border-t border-surface-200"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Refresh — invalidates every cached query. While anything is fetching,
          the icon spins and the button is disabled to prevent double-click
          stampedes. Title attr shows freshness ("Updated 5s ago") on hover. */}
      <button
        onClick={handleRefresh}
        disabled={fetching > 0}
        className="btn-outline"
        title={fetching > 0 ? 'Refreshing…' : `Updated ${updatedLabel}`}
        aria-label="Refresh data"
      >
        <RefreshCw size={14} className={fetching > 0 ? 'animate-spin' : ''} />
        <span className="hidden sm:inline">{fetching > 0 ? 'Refreshing…' : 'Refresh'}</span>
      </button>

      {onExport && (
        <button onClick={onExport} className="btn-outline">
          <Download size={14} /> Export CSV
        </button>
      )}
    </div>
  );
}
