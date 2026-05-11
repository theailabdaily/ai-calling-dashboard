'use client';
import type { CampaignRow } from '@/types';
import { fmt } from '@/lib/api';

export default function CampaignTable({ data }: { data: CampaignRow[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-brand-navy">Campaign breakdown</h3>
          <p className="text-xs text-surface-500">
            Performance by campaign — <span className="font-medium">Leads</span> = unique phones,{' '}
            <span className="font-medium">Dials</span> = total attempts incl. retries
          </p>
        </div>
        <span className="text-xs text-surface-500">{data.length} campaigns</span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0">
            <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
              <th className="px-5 py-3 font-medium">Campaign</th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Unique phone numbers in this campaign — the pool being called"
              >
                Leads
              </th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Total dial attempts including retries"
              >
                Dials
              </th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Unique leads connected (% of Leads)"
              >
                Connected
              </th>
              <th
                className="px-5 py-3 font-medium text-right"
                title="Unique leads marked interested (% of Connected)"
              >
                Interested
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map(c => {
              const label = c.display_name || c.campaign_name;
              const leads = c.unique_leads ?? 0;
              return (
                <tr
                  key={c.campaign_id}
                  className="border-t border-surface-100 hover:bg-surface-50"
                >
                  <td
                    className="px-5 py-3 font-medium text-brand-navy max-w-[460px] truncate"
                    title={label}
                  >
                    {label}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {fmt.int(leads)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-surface-600">
                    {fmt.int(c.total_calls)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <span className="font-medium">{fmt.int(c.connected_calls)}</span>
                    <span className="text-surface-500 ml-1.5 text-xs">
                      ({fmt.pct(c.connection_rate)})
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    <span className="font-medium">{fmt.int(c.interested_calls)}</span>
                    <span className="text-surface-500 ml-1.5 text-xs">
                      ({fmt.pct(c.interest_rate)})
                    </span>
                  </td>
                </tr>
              );
            })}
            {!data.length && (
              <tr>
                <td
                  colSpan={5}
                  className="text-center py-8 text-surface-500 text-sm"
                >
                  No campaigns in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
