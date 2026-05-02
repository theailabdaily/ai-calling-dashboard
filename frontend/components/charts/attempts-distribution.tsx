'use client';
import type { AttemptsDistribution as AD } from '@/types';

type Props = {
  data?: AD;
  isLoading?: boolean;
};

// Color the bar by attempt count: 1 attempt = green (one-and-done is ideal),
// 2 = neutral, 3+ = warmer/redder (retry waste creeping in). The vendor
// max_retries setting determines the natural top of the distribution; bars
// past that are usually a bug or cross-campaign double-dial.
function tone(attempts: number): { bar: string; bg: string } {
  if (attempts <= 1) return { bar: 'bg-emerald-500',  bg: 'bg-emerald-50' };
  if (attempts === 2) return { bar: 'bg-emerald-300', bg: 'bg-emerald-50/40' };
  if (attempts === 3) return { bar: 'bg-amber-400',   bg: 'bg-amber-50' };
  if (attempts <= 5)  return { bar: 'bg-amber-500',   bg: 'bg-amber-50' };
  return { bar: 'bg-red-500', bg: 'bg-red-50' };
}

export default function AttemptsDistribution({ data, isLoading }: Props) {
  if (isLoading) {
    return <div className="card p-6 text-sm text-surface-500">Loading dial frequency…</div>;
  }

  const rows = data?.rows || [];
  const totalLeads = data?.total_leads ?? 0;
  const totalCalls = data?.total_calls ?? 0;

  // Bar normalization: scale every bar against the largest pct_of_leads in
  // the table so the longest row hits ~100% width and small ones stay visible.
  const maxPct = Math.max(...rows.map(r => r.pct_of_leads), 0.01);

  const avgPerLead = totalLeads > 0 ? (totalCalls / totalLeads).toFixed(2) : '—';

  return (
    <div className="card overflow-hidden">
      <div className="px-4 md:px-5 py-3 md:py-4 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-brand-navy">Dial frequency per lead</h3>
        <p className="text-xs text-surface-500 mt-0.5">
          How many times each unique lead was attempted. Sum of leads = unique leads on Overview.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-surface-500 bg-surface-50/50">
              <th className="text-left  px-3 md:px-5 py-2 font-medium">Attempts</th>
              <th className="text-right px-3 py-2 font-medium">#leads</th>
              <th className="text-right px-3 md:px-5 py-2 font-medium w-[110px] md:w-[180px]">%leads</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center py-8 text-xs text-surface-500">
                  No data in this window.
                </td>
              </tr>
            )}
            {rows.map(r => {
              const t = tone(r.attempts);
              const widthPct = Math.max(2, (r.pct_of_leads / maxPct) * 100);
              return (
                <tr key={r.attempts} className="border-t border-surface-100">
                  <td className="px-3 md:px-5 py-2 text-brand-navy tabular-nums">
                    {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.leads.toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 md:px-5 py-2">
                    <div className="flex items-center gap-2">
                      <div className={`flex-1 h-2 rounded-full ${t.bg} overflow-hidden`}>
                        <div className={`h-full ${t.bar}`} style={{ width: `${widthPct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-surface-700 w-10 md:w-12 text-right shrink-0">
                        {(r.pct_of_leads * 100).toFixed(1)}%
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
                  {totalLeads.toLocaleString('en-IN')} leads
                </td>
                <td className="px-3 md:px-5 py-2 text-right text-xs text-surface-500 tabular-nums">
                  avg {avgPerLead}/lead
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
