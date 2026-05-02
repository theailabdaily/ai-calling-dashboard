'use client';
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { CalendarDays } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { DowBucket } from '@/types';

type Props = { data: DowBucket[] };

const FULL_WEEK = [
  { dow: 1, dow_name: 'Mon' },
  { dow: 2, dow_name: 'Tue' },
  { dow: 3, dow_name: 'Wed' },
  { dow: 4, dow_name: 'Thu' },
  { dow: 5, dow_name: 'Fri' },
  { dow: 6, dow_name: 'Sat' },
  { dow: 7, dow_name: 'Sun' },
];

export default function DowChart({ data }: Props) {
  if (!data.length) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Day of week breakdown</h3>
        <div className="text-xs text-surface-500 py-8 text-center">No call data in this window.</div>
      </div>
    );
  }

  // Fill in missing days
  const byDow = new Map(data.map(d => [d.dow, d]));
  const filled = FULL_WEEK.map(w => {
    const found = byDow.get(w.dow);
    return found ?? {
      dow: w.dow, dow_name: w.dow_name,
      total_calls: 0, connected_calls: 0, engaged_calls: 0, interested_calls: 0,
      avg_duration_seconds: 0, connection_rate: 0, engagement_rate: 0, interest_rate: 0,
    };
  });

  const chartRows = filled.map(b => ({
    day: b.dow_name,
    Total: b.total_calls,
    Connected: b.connected_calls,
    Interested: b.interested_calls,
    'Conn %':     +(b.connection_rate * 100).toFixed(1),
    'Interest %': +(b.interest_rate * 100).toFixed(1),
  }));

  const totalCalls = data.reduce((s, b) => s + b.total_calls, 0);
  const activeDays = data.filter(b => b.total_calls > 0).length;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
          <CalendarDays size={14} className="text-brand-pink" />
          Day of week breakdown (IST)
        </h3>
        <span className="text-xs text-surface-500">
          {fmt.int(totalCalls)} calls across {activeDays} day{activeDays !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        Same metrics rolled up by weekday. Tells you Tue 6 PM vs Sat 6 PM at a glance.
      </p>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartRows} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#6B7280' }} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6B7280' }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6B7280' }} unit="%" />
            <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            <Bar yAxisId="left" dataKey="Total"      fill="#1B1A36" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Connected"  fill="#94A3B8" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Interested" fill="#10B981" radius={[3, 3, 0, 0]} />
            <Line yAxisId="right" dataKey="Conn %"     stroke="#E8345C" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="right" dataKey="Interest %" stroke="#10B981" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
