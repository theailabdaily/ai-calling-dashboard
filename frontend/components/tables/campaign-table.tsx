'use client';
import type { CampaignRow } from '@/types';
import { fmt } from '@/lib/api';

type Props = {
  data: CampaignRow[];
  isLoading?: boolean;
  isError?: boolean;
};

export default function CampaignTable({ data, isLoading, isError }: Props) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-brand-navy">Campaign breakdown</h3>
          <p className="text-xs text-surface-500 mt-0.5">
            <span className="font-medium">Leads</span> = unique phones called.{' '}
            <span className="font-medium">Dials</span> = total attempts incl. retries.
          </p>
        </div>
        <span className="text-xs text-surface-500 whitespace-nowrap shrink-0">
          {data.length} campaign{data.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-surface-50">
            <tr className="text-left text-xs uppercase tracking-wider text-surface-500">
              <th className="px-5 py-3 font-medium">Campaign</th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Unique phone numbers in this campaign"
              >
                Leads
              </th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Total dial attempts (includes retries)"
              >
                Dials
              </th>
              <th
                className="px-3 py-3 font-medium text-right"
                title="Unique leads connected. % shown is of Leads."
              >
                Connected
              </th>
              <th
                className="px-5 py-3 font-medium text-right"
                title="Unique leads marked interested. % shown is of Connected."
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
                  {isLoading
                    ? 'Loading…'
                    : isError
                    ? 'Could not load campaign data. Try refreshing.'
                    : 'No campaigns in this window.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
