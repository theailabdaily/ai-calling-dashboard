'use client';
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { Clock } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { HourBucket } from '@/types';

type Props = { data: HourBucket[] };

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

export default function HourDetail({ data }: Props) {
  if (!data.length) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Hour of day breakdown</h3>
        <div className="text-xs text-surface-500 py-8 text-center">No call data in this window.</div>
      </div>
    );
  }

  // Fill 0..23 so X axis is continuous
  const byHour = new Map(data.map(d => [d.hour, d]));
  const filled: HourBucket[] = Array.from({ length: 24 }, (_, h) =>
    byHour.get(h) || {
      hour: h, total_calls: 0, connected_calls: 0, engaged_calls: 0,
      interested_calls: 0, avg_duration_seconds: 0,
      connection_rate: 0, engagement_rate: 0, interest_rate: 0,
    }
  );

  const chartRows = filled.map(b => ({
    hour: hourLabel(b.hour),
    Total: b.total_calls,
    Connected: b.connected_calls,
    Engaged: b.engaged_calls,
    Interested: b.interested_calls,
    'Conn %':     +(b.connection_rate * 100).toFixed(1),
    'Engage %':   +(b.engagement_rate * 100).toFixed(1),
    'Interest %': +(b.interest_rate * 100).toFixed(1),
    'Avg dur':    Math.round(b.avg_duration_seconds),
  }));

  const totalCalls = data.reduce((s, b) => s + b.total_calls, 0);
  const activeHours = data.filter(b => b.total_calls > 0).length;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
          <Clock size={14} className="text-brand-pink" />
          Hour of day breakdown (IST)
        </h3>
        <span className="text-xs text-surface-500">
          {fmt.int(totalCalls)} calls across {activeHours} hour{activeHours !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        Volume bars (left axis) + rate lines (right axis). All four funnel stages stacked together.
      </p>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartRows} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#6B7280' }} interval={1} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6B7280' }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6B7280' }} unit="%" />
            <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            <Bar yAxisId="left" dataKey="Total"      fill="#1B1A36" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Connected"  fill="#94A3B8" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Engaged"    fill="#CBD5E1" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Interested" fill="#10B981" radius={[3, 3, 0, 0]} />
            <Line yAxisId="right" dataKey="Conn %"     stroke="#E8345C" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="right" dataKey="Engage %"   stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="2 2" dot={false} />
            <Line yAxisId="right" dataKey="Interest %" stroke="#10B981" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
