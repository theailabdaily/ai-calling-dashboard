'use client';
import type { VendorRow } from '@/types';
import { fmt } from '@/lib/api';

export default function VendorTable({ data }: { data: VendorRow[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-brand-navy">Vendor comparison</h3>
        <p className="text-xs text-surface-500">Side-by-side metrics</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
              <th className="px-5 py-3 font-medium">Vendor</th>
              <th className="px-3 py-3 font-medium text-right">Total calls</th>
              <th className="px-3 py-3 font-medium text-right">Connected</th>
              <th className="px-3 py-3 font-medium text-right">Conn. rate</th>
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
                <td className="px-3 py-3 text-right tabular-nums">{fmt.int(v.total_calls)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.int(v.connected_calls)}</td>
                <td className="px-3 py-3 text-right tabular-nums font-medium">{fmt.pct(v.connection_rate)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.duration(v.avg_duration_seconds)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.pct(v.engagement_rate)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt.pct(v.interest_rate)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{fmt.pct(v.follow_up_rate)}</td>
              </tr>
            ))}
            {!data.length && (
              <tr><td colSpan={8} className="text-center py-8 text-surface-500 text-sm">No vendor data yet — run a sync.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
