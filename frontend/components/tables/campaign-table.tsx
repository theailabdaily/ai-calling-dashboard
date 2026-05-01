'use client';
import type { CampaignRow } from '@/types';
import { fmt } from '@/lib/api';

export default function CampaignTable({ data }: { data: CampaignRow[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-brand-navy">Campaign breakdown</h3>
          <p className="text-xs text-surface-500">Performance by campaign</p>
        </div>
        <span className="text-xs text-surface-500">{data.length} campaigns</span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
              <th className="px-5 py-3 font-medium">Campaign</th>
              <th className="px-3 py-3 font-medium">Started</th>
              <th className="px-3 py-3 font-medium text-right">Total</th>
              <th className="px-3 py-3 font-medium text-right">Connected</th>
              <th className="px-3 py-3 font-medium text-right">Conn. rate</th>
              <th className="px-3 py-3 font-medium text-right">Interested</th>
              <th className="px-5 py-3 font-medium text-right">Int. rate</th>
            </tr>
          </thead>
          <tbody>
            {data.map(c => (
              <tr key={c.campaign_id} className="border-t border-surface-100 hover:bg-surface-50">
                <td className="px-5 py-3 font-medium text-brand-navy max-w-[300px] truncate" title={c.campaign_name}>
                  {c.campaign_name}
                </td>
                <td className="px-3 py-3 text-xs text-surface-500 whitespace-nowrap">
                  {c.started_at ? new Date(c.started_at).toLocaleDateString('en-IN') : '—'}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.int(c.total_calls)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.int(c.connected_calls)}</td>
                <td className="px-3 py-3 text-right tabular-nums font-medium">{fmt.pct(c.connection_rate)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.int(c.interested_calls)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{fmt.pct(c.interest_rate)}</td>
              </tr>
            ))}
            {!data.length && (
              <tr><td colSpan={7} className="text-center py-8 text-surface-500 text-sm">No campaigns in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
