'use client';
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Users } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { VendorHourSplit, HourBucket } from '@/types';

type Props = { data: VendorHourSplit[] };

function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  if (h < 12) return `${h}a`;
  return `${h - 12}p`;
}

function fillHours(hours: HourBucket[]): HourBucket[] {
  const byHour = new Map(hours.map(d => [d.hour, d]));
  return Array.from({ length: 24 }, (_, h) =>
    byHour.get(h) || {
      hour: h, total_calls: 0, connected_calls: 0, engaged_calls: 0,
      interested_calls: 0, avg_duration_seconds: 0,
      connection_rate: 0, engagement_rate: 0, interest_rate: 0,
    }
  );
}

export default function HourByVendor({ data }: Props) {
  if (!data.length) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Hour split by vendor</h3>
        <div className="text-xs text-surface-500 py-8 text-center">No vendor data in this window.</div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-brand-navy mb-1 flex items-center gap-1.5">
        <Users size={14} className="text-brand-pink" />
        Hour split by vendor (IST)
      </h3>
      <p className="text-xs text-surface-500 mb-4">
        One mini-chart per vendor. Spots whether vendors peak at different hours.
      </p>

      <div className={`grid grid-cols-1 ${data.length >= 2 ? 'md:grid-cols-2' : ''} gap-4`}>
        {data.map(v => {
          const filled = fillHours(v.hours);
          const rows = filled.map(b => ({
            hour: hourLabel(b.hour),
            Total: b.total_calls,
            'Conn %': +(b.connection_rate * 100).toFixed(1),
          }));
          const totalCalls = v.hours.reduce((s, b) => s + b.total_calls, 0);
          const peak = [...v.hours].filter(h => h.total_calls >= 30)
            .sort((a, b) => b.connection_rate - a.connection_rate)[0];

          return (
            <div key={v.vendor_id} className="bg-surface-50 rounded-lg p-3 border border-surface-100">
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-sm font-medium text-brand-navy">{v.vendor_name}</div>
                <div className="text-[11px] text-surface-500">
                  {fmt.int(totalCalls)} calls
                  {peak && ` · peak ${hourLabel(peak.hour)} (${fmt.pct(peak.connection_rate)})`}
                </div>
              </div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
                    <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#6B7280' }} interval={2} />
                    <YAxis yAxisId="left" tick={{ fontSize: 9, fill: '#6B7280' }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: '#6B7280' }} unit="%" />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="Total" fill="#1B1A36" radius={[2, 2, 0, 0]} />
                    <Line yAxisId="right" dataKey="Conn %" stroke="#E8345C" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
