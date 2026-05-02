'use client';
import type { OutcomeDistribution as OD, OutcomeRow } from '@/types';

type Props = {
  data?: OD;
  isLoading?: boolean;
};

// Color the % bar by outcome family — green-ish for booked, amber for objections,
// gray for connection failures, red for hard fails. Helps eyes scan a long table.
function rowTone(outcome: string): { bar: string; bg: string } {
  const o = outcome.toLowerCase();
  if (o.includes('booked') || o.includes('high interest')) return { bar: 'bg-emerald-500', bg: 'bg-emerald-50' };
  if (o.includes('medium interest') || o.includes('low interest')) return { bar: 'bg-emerald-300', bg: 'bg-emerald-50/40' };
  if (o.includes('not interested') || o.includes('objection')) return { bar: 'bg-amber-500', bg: 'bg-amber-50' };
  if (o.includes('voicemail') || o.includes('not answered') || o.includes('hangup') || o.includes('outcome unclear')) return { bar: 'bg-slate-400', bg: 'bg-slate-50' };
  if (o.includes('failed') || o.includes('cancelled')) return { bar: 'bg-red-400', bg: 'bg-red-50' };
  if (o.includes('scheduled')) return { bar: 'bg-blue-300', bg: 'bg-blue-50' };
  return { bar: 'bg-surface-300', bg: 'bg-surface-50' };
}

function OutcomeTable({
  rows, title, subtitle, unitLabel,
}: {
  rows: OutcomeRow[];
  title: string;
  subtitle: string;
  unitLabel: string;  // "leads" or "calls"
}) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  // Bar width is normalized to the largest row in this table (so the top row
  // always fills ~100%); easier to scan than absolute percent.
  const max = rows[0]?.pct || 1;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-brand-navy">{title}</h3>
        <p className="text-xs text-surface-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-surface-500 bg-surface-50/50">
              <th className="text-left px-5 py-2 font-medium">Outcome</th>
              <th className="text-right px-3 py-2 font-medium">#{unitLabel}</th>
              <th className="text-right px-5 py-2 font-medium w-[180px]">%{unitLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="text-center py-8 text-xs text-surface-500">No data in this window.</td></tr>
            )}
            {rows.map((r) => {
              const tone = rowTone(r.outcome);
              const widthPct = Math.max(2, (r.pct / max) * 100); // min 2% for visibility
              return (
                <tr key={r.outcome} className="border-t border-surface-100">
                  <td className="px-5 py-2 text-brand-navy">{r.outcome}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.count.toLocaleString('en-IN')}</td>
                  <td className="px-5 py-2">
                    <div className="flex items-center gap-2">
                      <div className={`flex-1 h-2 rounded-full ${tone.bg} overflow-hidden`}>
                        <div className={`h-full ${tone.bar}`} style={{ width: `${widthPct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-surface-700 w-12 text-right">
                        {(r.pct * 100).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-surface-200 bg-surface-50/50">
                <td className="px-5 py-2 text-xs font-medium text-surface-700">Total</td>
                <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums">{total.toLocaleString('en-IN')}</td>
                <td className="px-5 py-2 text-right text-xs text-surface-500">{rows.length} categories</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export default function OutcomeDistribution({ data, isLoading }: Props) {
  if (isLoading) {
    return <div className="card p-6 text-sm text-surface-500">Loading outcome distribution…</div>;
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <OutcomeTable
        rows={data?.by_lead || []}
        title="Lead-level outcomes"
        subtitle="Last call outcome per unique mobile number. Honest view — one row per person."
        unitLabel="leads"
      />
      <OutcomeTable
        rows={data?.by_call || []}
        title="Call-level outcomes"
        subtitle="Every call attempt counted separately. Higher numbers reflect retries on the same lead."
        unitLabel="calls"
      />
    </div>
  );
}
