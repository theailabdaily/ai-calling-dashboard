'use client';
import type { AttemptsDistribution as AD } from '@/types';

type Props = {
  data?: AD;
  isLoading?: boolean;
};

// The interesting question this view answers is: "if a lead has been dialed N
// times, what's the chance they ever picked up?" — high N + low connect_rate
// is wasted vendor budget. We color the connect_rate bar to make that scan-able:
//   green = healthy pickup (≥50%)
//   amber = borderline   (15–50%)
//   red   = waste signal (<15%)
function rateTone(rate: number): { bar: string; bg: string; text: string } {
  if (rate >= 0.5) return  { bar: 'bg-emerald-500', bg: 'bg-emerald-50', text: 'text-emerald-700' };
  if (rate >= 0.15) return { bar: 'bg-amber-500',   bg: 'bg-amber-50',   text: 'text-amber-700' };
  return                   { bar: 'bg-red-500',     bg: 'bg-red-50',     text: 'text-red-700' };
}

export default function AttemptsDistribution({ data, isLoading }: Props) {
  if (isLoading) {
    return <div className="card p-6 text-sm text-surface-500">Loading dial frequency…</div>;
  }

  const rows = data?.rows || [];
  const totalLeads = data?.total_leads ?? 0;
  const totalConnected = data?.total_connected ?? 0;
  const totalCalls = data?.total_calls ?? 0;

  // The lead-share bar is normalized to the largest bucket so the eye can scan
  // cohort sizes. The connect-rate bar uses absolute % (0–100) — pickup rate
  // is naturally read on a 0–100 axis.
  const maxLeadShare = Math.max(...rows.map(r => r.pct_of_leads), 0.01);

  const avgPerLead = totalLeads > 0 ? (totalCalls / totalLeads).toFixed(2) : '—';
  const overallConnect = totalLeads > 0 ? ((totalConnected / totalLeads) * 100).toFixed(1) : '—';

  return (
    <div className="card overflow-hidden">
      <div className="px-4 md:px-5 py-3 md:py-4 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-brand-navy">Dial frequency × connection rate</h3>
        <p className="text-xs text-surface-500 mt-0.5">
          Each row = a cohort of leads with the same total dial count.
          <span className="hidden sm:inline"> Counts <code className="text-[11px] bg-surface-100 px-1 rounded">retry_count + 1</code> per call_log row, summed per lead. </span>
          Look for high-attempts cohorts with low connect rate — that's wasted retry budget.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-surface-500 bg-surface-50/50">
              <th className="text-left  px-3 md:px-5 py-2 font-medium">Attempts</th>
              <th className="text-right px-3 py-2 font-medium">#leads</th>
              <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">%leads</th>
              <th className="text-right px-3 py-2 font-medium">Connected</th>
              <th className="text-right px-3 md:px-5 py-2 font-medium w-[120px] md:w-[200px]">Connect rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-xs text-surface-500">
                  No data in this window.
                </td>
              </tr>
            )}
            {rows.map(r => {
              const t = rateTone(r.connect_rate);
              const widthPct = Math.max(2, r.connect_rate * 100);
              const leadShareW = Math.max(2, (r.pct_of_leads / maxLeadShare) * 100);
              return (
                <tr key={r.attempts} className="border-t border-surface-100">
                  <td className="px-3 md:px-5 py-2 text-brand-navy tabular-nums">
                    {r.attempts === 0 ? 'Not yet dialed' : `${r.attempts} ${r.attempts === 1 ? 'attempt' : 'attempts'}`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.leads.toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                    <div className="inline-flex items-center gap-1.5">
                      <div className="w-12 h-1.5 rounded-full bg-surface-100 overflow-hidden">
                        <div className="h-full bg-brand-navy/40" style={{ width: `${leadShareW}%` }} />
                      </div>
                      <span className="text-xs text-surface-700 w-10 text-right">{(r.pct_of_leads * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-surface-700">
                    {r.connected.toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 md:px-5 py-2">
                    <div className="flex items-center gap-2">
                      <div className={`flex-1 h-2 rounded-full ${t.bg} overflow-hidden`}>
                        <div className={`h-full ${t.bar}`} style={{ width: `${widthPct}%` }} />
                      </div>
                      <span className={`text-xs tabular-nums w-10 md:w-12 text-right shrink-0 font-medium ${t.text}`}>
                        {(r.connect_rate * 100).toFixed(1)}%
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
                <td className="px-3 md:px-5 py-2 text-xs font-medium text-surface-700">Total</td>
                <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums">
                  {totalLeads.toLocaleString('en-IN')}
                </td>
                <td className="px-3 py-2 text-right text-xs text-surface-500 tabular-nums hidden sm:table-cell">
                  avg {avgPerLead}/lead
                </td>
                <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-surface-700">
                  {totalConnected.toLocaleString('en-IN')}
                </td>
                <td className="px-3 md:px-5 py-2 text-right text-xs text-surface-500 tabular-nums">
                  overall {overallConnect}%
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
