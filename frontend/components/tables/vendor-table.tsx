'use client';
import type { VendorRow } from '@/types';
import { fmt } from '@/lib/api';

type Props = {
  data: VendorRow[];
  isLoading?: boolean;
  isError?: boolean;
};

export default function VendorTable({ data, isLoading, isError }: Props) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-brand-navy">Vendor comparison</h3>
        <p className="text-xs text-surface-500">Side-by-side metrics across vendors</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-50">
            <tr className="text-left text-xs uppercase tracking-wider text-surface-500">
              <th className="px-5 py-3 font-medium">Vendor</th>
              <th className="px-3 py-3 font-medium text-right">Total dials</th>
              <th className="px-3 py-3 font-medium text-right">Connected</th>
              <th className="px-3 py-3 font-medium text-right">Avg. duration</th>
              <th className="px-3 py-3 font-medium text-right">Engaged</th>
              <th className="px-3 py-3 font-medium text-right">Interested</th>
              <th className="px-5 py-3 font-medium text-right">Follow-up</th>
            </tr>
          </thead>
          <tbody>
            {data.map(v => (
              <tr key={v.vendor_id} className="border-t border-surface-100 hover:bg-surface-50">
                <td className="px-5 py-3 font-medium text-brand-navy">{v.vendor_name}</td>
                <td className="px-3 py-3 text-right tabular-nums text-surface-600">
                  {fmt.int(v.total_calls)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  <span className="font-medium">{fmt.int(v.connected_calls)}</span>
                  <span className="text-surface-500 ml-1.5 text-xs">
                    ({fmt.pct(v.connection_rate)})
                  </span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {fmt.duration(v.avg_duration_seconds)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {fmt.pct(v.engagement_rate)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {fmt.pct(v.interest_rate)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {fmt.pct(v.follow_up_rate)}
                </td>
              </tr>
            ))}
            {!data.length && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-surface-500 text-sm">
                  {isLoading
                    ? 'Loading…'
                    : isError
                    ? 'Could not load vendor data. Try refreshing.'
                    : 'No vendor activity in this window.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
