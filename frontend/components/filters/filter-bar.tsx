'use client';
import { useQuery } from '@tanstack/react-query';
import { Calendar, ChevronDown, Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, cn } from '@/lib/api';
import type { Filters } from '@/types';

const PRESETS = [
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
  { label: 'Last 90d', days: 90 },
  { label: 'YTD', days: -1 },  // sentinel
];

function applyPreset(days: number): { start: Date; end: Date } {
  const end = new Date();
  if (days === -1) {
    return { start: new Date(end.getFullYear(), 0, 1), end };
  }
  const start = new Date(end);
  start.setDate(end.getDate() - days);
  return { start, end };
}

type Props = {
  filters: Filters;
  onChange: (f: Filters) => void;
  onExport?: () => void;
};

export default function FilterBar({ filters, onChange, onExport }: Props) {
  const [vendorOpen, setVendorOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);

  const vendors = useQuery({ queryKey: ['vendors'], queryFn: api.vendors });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns });

  const visibleCampaigns = (campaigns.data || []).filter(c =>
    filters.vendor_ids.length === 0 || filters.vendor_ids.includes(c.vendor_id)
  );

  const toggle = (id: string, key: 'vendor_ids' | 'campaign_ids') => {
    const set = new Set(filters[key]);
    set.has(id) ? set.delete(id) : set.add(id);
    onChange({ ...filters, [key]: [...set] });
  };

  return (
    <div className="card p-4 flex flex-wrap items-center gap-3">
      {/* Date range presets */}
      <div className="flex items-center gap-1">
        <Calendar size={16} className="text-surface-500 mr-1" />
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => onChange({ ...filters, ...applyPreset(p.days) })}
            className="btn-ghost px-2.5 py-1.5 text-xs"
          >
            {p.label}
          </button>
        ))}
        <span className="text-xs text-surface-500 ml-2">
          {filters.start.toLocaleDateString('en-IN')} → {filters.end.toLocaleDateString('en-IN')}
        </span>
      </div>

      <div className="flex-1" />

      {/* Vendor multi-select */}
      <div className="relative">
        <button onClick={() => setVendorOpen(o => !o)} className="btn-outline">
          Vendors
          {filters.vendor_ids.length > 0 && (
            <span className="pill bg-brand-pink/10 text-brand-pink ml-1">{filters.vendor_ids.length}</span>
          )}
          <ChevronDown size={14} />
        </button>
        {vendorOpen && (
          <div className="absolute right-0 top-full mt-1 w-56 card p-2 z-20">
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
          </div>
        )}
      </div>

      {/* Campaign multi-select */}
      <div className="relative">
        <button onClick={() => setCampaignOpen(o => !o)} className="btn-outline">
          Campaigns
          {filters.campaign_ids.length > 0 && (
            <span className="pill bg-brand-pink/10 text-brand-pink ml-1">{filters.campaign_ids.length}</span>
          )}
          <ChevronDown size={14} />
        </button>
        {campaignOpen && (
          <div className="absolute right-0 top-full mt-1 w-72 card p-2 z-20 max-h-80 overflow-y-auto">
            {visibleCampaigns.map(c => (
              <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.campaign_ids.includes(c.id)}
                  onChange={() => toggle(c.id, 'campaign_ids')}
                  className="accent-brand-pink"
                />
                <span className="text-sm truncate">{c.name}</span>
              </label>
            ))}
            {!visibleCampaigns.length && <div className="text-xs text-surface-500 p-2">No campaigns yet</div>}
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
