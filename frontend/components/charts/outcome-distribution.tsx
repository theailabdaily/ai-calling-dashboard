'use client';
import { useQuery } from '@tanstack/react-query';
import { Calendar, ChevronDown, Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Filters } from '@/types';

type PresetKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'ytd';

const PRESETS: { label: string; key: PresetKey }[] = [
  { label: 'Today',     key: 'today' },
  { label: 'Yesterday', key: 'yesterday' },
  { label: 'Last 7d',   key: 'last7' },
  { label: 'Last 30d',  key: 'last30' },
  { label: 'Last 90d',  key: 'last90' },
  { label: 'YTD',       key: 'ytd' },
];

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
    case 'last30':
    case 'last90': {
      const days = key === 'last7' ? 7 : key === 'last30' ? 30 : 90;
      const start = new Date(now); start.setDate(start.getDate() - days);
      return { start: startOfDay(start), end: endOfDay(now) };
    }
    case 'ytd': {
      return { start: new Date(now.getFullYear(), 0, 1), end: endOfDay(now) };
    }
  }
}

// "2026-04-30" → Date (local); used for <input type="date"> binding
function parseInputDate(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

  const setStart = (s: string) => {
    const d = parseInputDate(s);
    if (d) onChange({ ...filters, start: startOfDay(d) });
  };
  const setEnd = (s: string) => {
    const d = parseInputDate(s);
    if (d) onChange({ ...filters, end: endOfDay(d) });
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

      {/* Custom range */}
      <div className="flex items-center gap-1 text-xs text-surface-600">
        <input
          type="date"
          value={toInputDate(filters.start)}
          onChange={e => setStart(e.target.value)}
          className="px-2 py-1.5 rounded border border-surface-300 text-xs focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        />
        <span className="text-surface-400">→</span>
        <input
          type="date"
          value={toInputDate(filters.end)}
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

      {onExport && (
        <button onClick={onExport} className="btn-outline">
          <Download size={14} /> Export CSV
        </button>
      )}
    </div>
  );
}
