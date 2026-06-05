'use client';
import Link from 'next/link';
import { Info } from 'lucide-react';
import type { ConnectedBreakdown as CB, Filters } from '@/types';
import { fmt } from '@/lib/api';

type Props = {
  data?: CB;
  total?: number;          // connected_calls — for percentage labels
  filters: Filters;        // for click-through deep-linking to /calls
};

// Each interest bucket gets a color. Greens = warm, amber = lukewarm,
// slate = bot couldn't qualify, red = hard fail. Order matches sales priority.
const SEGMENTS: Array<{
  key: keyof CB;
  label: string;
  color: string;          // bar color
  funnelStage?: string;   // for click-through; absent = not drillable
  description: string;
}> = [
  { key: 'high',          label: 'HIGH',          color: 'bg-emerald-600', funnelStage: 'interested', description: 'Strongest interest signal. UGC NET: HIGH interest_level. UPSC: serious upsc_interest_status or counsellor_scheduled.' },
  { key: 'medium',        label: 'MEDIUM',        color: 'bg-emerald-400', funnelStage: 'interested', description: 'Good interest signal. UGC NET: MEDIUM interest_level. UPSC: exploratory upsc_interest_status. HIGH+MEDIUM = Interested.' },
  { key: 'low',           label: 'LOW',           color: 'bg-amber-400',                                description: 'Low interest. UGC NET: LOW. UPSC: casual upsc_interest_status. Some still request follow-up.' },
  { key: 'not_covered',   label: 'NOT COVERED',   color: 'bg-slate-400',                                description: 'Bot did not qualify. UGC NET: NOT_COVERED. UPSC: not_interested or dropped upsc_interest_status.' },
  { key: 'not_available', label: 'NOT AVAILABLE', color: 'bg-slate-300',                                description: 'Audio issue or call too short to classify. Effectively unclassifiable.' },
  { key: 'unclassified',  label: 'OTHER',         color: 'bg-surface-300',                              description: 'Missing or unrecognised interest signal. Check agent result schema if this bucket is large.' },
];

export default function ConnectedBreakdown({ data, total, filters }: Props) {
  if (!data || !total) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy">Connected breakdown</h3>
        <p className="text-xs text-surface-500 mt-1">Loading…</p>
      </div>
    );
  }

  // Compute percentages of connected for each segment.
  const segs = SEGMENTS.map(s => ({
    ...s,
    count: data[s.key] || 0,
    pct: total > 0 ? ((data[s.key] || 0) / total) * 100 : 0,
  })).filter(s => s.count > 0);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-brand-navy">
          Connected breakdown · {fmt.int(total)}
        </h3>
        <span className="text-[11px] text-surface-500">by interest level</span>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        Where the conversations went. HIGH + MEDIUM (UGC NET) or serious/exploratory (UPSC) = the "Interested" funnel stage.
      </p>

      {/* Single stacked bar — proportions visible at a glance. */}
      <div className="flex h-3 rounded-md overflow-hidden bg-surface-100 mb-3">
        {segs.map(s => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${s.pct}%` }}
            title={`${s.label}: ${s.count} (${s.pct.toFixed(1)}%)`}
          />
        ))}
      </div>

      {/* Legend with counts — readable on its own without hover. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {segs.map(s => {
          const tipId = `cb-tip-${s.key}`;
          const inner = (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-surface-50 transition-colors group">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2.5 h-2.5 rounded-sm ${s.color} shrink-0`} />
                <span className="text-[11px] font-medium text-surface-700 truncate">
                  {s.label}
                </span>
                <span className="relative inline-flex items-center" aria-describedby={tipId}>
                  <Info size={11} className="text-surface-400 hover:text-surface-600 cursor-help" />
                  <span
                    id={tipId}
                    role="tooltip"
                    className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity
                               absolute left-0 bottom-full mb-1 z-20 w-56 px-2 py-1.5 rounded-md
                               bg-brand-navy text-white text-[11px] leading-snug shadow-lg pointer-events-none"
                  >
                    {s.description}
                  </span>
                </span>
              </div>
              <div className="text-[11px] tabular-nums whitespace-nowrap">
                <span className="font-semibold text-brand-navy">{fmt.int(s.count)}</span>
                <span className="text-surface-500 ml-1">({s.pct.toFixed(0)}%)</span>
              </div>
            </div>
          );

          if (s.funnelStage) {
            const q = new URLSearchParams({
              start: filters.start.toISOString(),
              end:   filters.end.toISOString(),
              funnel_stage: s.funnelStage,
            });
            // Carry forward vendor/campaign selections so the calls page
            // doesn't silently widen the filter on click-through.
            for (const v of (filters.vendor_ids || [])) q.append('vendor_ids', v);
            for (const c of (filters.campaign_ids || [])) q.append('campaign_ids', c);
            return (
              <Link key={s.key} href={`/calls?${q.toString()}`} className="block">
                {inner}
              </Link>
            );
          }
          return <div key={s.key}>{inner}</div>;
        })}
      </div>
    </div>
  );
}
