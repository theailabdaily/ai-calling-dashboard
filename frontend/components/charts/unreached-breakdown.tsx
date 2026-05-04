'use client';
import { Info } from 'lucide-react';
import type { UnreachedBreakdown as UB } from '@/types';
import { fmt } from '@/lib/api';

type Props = {
  data?: UB;
  total?: number;   // unreached_total — for the "X of Y" label
};

const SEGMENTS: Array<{
  key: keyof UB;
  label: string;
  color: string;
  description: string;
}> = [
  {
    key: 'in_progress', label: 'IN PROGRESS', color: 'bg-blue-400',
    description: 'Hunar is still retrying these — neither connected nor failed yet. The campaign is live. Wait before judging the funnel.',
  },
  {
    key: 'not_connected', label: 'NOT CONNECTED', color: 'bg-slate-400',
    description: 'Call attempted but no human pickup (busy, no answer, hangup before agent). Hunar exhausted retries.',
  },
  {
    key: 'voicemail', label: 'VOICEMAIL', color: 'bg-slate-300',
    description: 'Machine pickup detected. Hunar disconnects on voicemail — no message left.',
  },
  {
    key: 'failed', label: 'FAILED', color: 'bg-red-400',
    description: 'Technical failure — bad number, network error, carrier reject. Won\'t be retried.',
  },
];

export default function UnreachedBreakdown({ data, total }: Props) {
  if (!data || total === undefined) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy">Unreached</h3>
        <p className="text-xs text-surface-500 mt-1">Loading…</p>
      </div>
    );
  }

  const segs = SEGMENTS.map(s => ({
    ...s,
    count: data[s.key] || 0,
    pct: total > 0 ? ((data[s.key] || 0) / total) * 100 : 0,
  })).filter(s => s.count > 0);

  if (segs.length === 0 || total === 0) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy">Unreached · 0</h3>
        <p className="text-xs text-surface-500 mt-1">Every lead-attempt connected. Nice.</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-brand-navy">
          Unreached · {fmt.int(total)}
        </h3>
        <span className="text-[11px] text-surface-500">lead-attempts not connected</span>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        What happened to the rest. <strong>In Progress</strong> = still being retried,
        not a final outcome — these may yet convert.
      </p>

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

      <div className="grid grid-cols-2 gap-2">
        {segs.map(s => {
          const tipId = `ub-tip-${s.key}`;
          return (
            <div
              key={s.key}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md group hover:bg-surface-50 transition-colors"
            >
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
        })}
      </div>
    </div>
  );
}
