'use client';
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { TrendingUp, Clock } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { HourBucket } from '@/types';

type Props = { data: HourBucket[] };

// Format hour as "5 PM" / "12 AM" etc.
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

export default function HourlyAnalytics({ data }: Props) {
  if (!data.length) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Hourly performance</h3>
        <div className="text-xs text-surface-500 py-8 text-center">No call data in this window.</div>
      </div>
    );
  }

  // Fill in any missing hours with zeros so the X axis is continuous 0-23
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
    Interested: b.interested_calls,
    'Conn. rate': +(b.connection_rate * 100).toFixed(1),
    'Interest rate': +(b.interest_rate * 100).toFixed(1),
  }));

  // Find best & worst connection rate among hours with at least 30 calls
  const significant = data.filter(b => b.total_calls >= 30);
  const bestConn = significant.length
    ? [...significant].sort((a, b) => b.connection_rate - a.connection_rate)[0]
    : null;
  const bestInt = significant.length
    ? [...significant].sort((a, b) => b.interest_rate - a.interest_rate)[0]
    : null;

  const totalCalls = data.reduce((s, b) => s + b.total_calls, 0);
  const activeHours = data.filter(b => b.total_calls > 0).length;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
          <Clock size={14} className="text-brand-pink" />
          Hourly performance (IST)
        </h3>
        <span className="text-xs text-surface-500">
          {fmt.int(totalCalls)} calls across {activeHours} hour{activeHours !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        When customers actually pick up — and convert. Bars = volume, line = rates.
      </p>

      {(bestConn || bestInt) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
          {bestConn && (
            <div className="bg-emerald-50 rounded-lg px-3 py-2 flex items-start gap-2">
              <TrendingUp size={14} className="text-emerald-600 mt-0.5 shrink-0" />
              <div className="text-xs text-emerald-900">
                <strong>Best connection hour:</strong> {hourLabel(bestConn.hour)} —
                {' '}{fmt.pct(bestConn.connection_rate)} on {fmt.int(bestConn.total_calls)} calls
              </div>
            </div>
          )}
          {bestInt && bestInt.hour !== bestConn?.hour && (
            <div className="bg-brand-pink/10 rounded-lg px-3 py-2 flex items-start gap-2">
              <TrendingUp size={14} className="text-brand-pink mt-0.5 shrink-0" />
              <div className="text-xs text-brand-navy">
                <strong>Best conversion hour:</strong> {hourLabel(bestInt.hour)} —
                {' '}{fmt.pct(bestInt.interest_rate)} interest rate on connected
              </div>
            </div>
          )}
          {bestInt && bestInt.hour === bestConn?.hour && (
            <div className="bg-brand-pink/10 rounded-lg px-3 py-2 flex items-start gap-2">
              <TrendingUp size={14} className="text-brand-pink mt-0.5 shrink-0" />
              <div className="text-xs text-brand-navy">
                <strong>Sweet spot:</strong> {hourLabel(bestInt.hour)} leads on both connection
                {' '}({fmt.pct(bestInt.connection_rate)}) AND interest ({fmt.pct(bestInt.interest_rate)}).
              </div>
            </div>
          )}
        </div>
      )}

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartRows} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#6B7280' }} interval={1} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6B7280' }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#6B7280' }} unit="%" />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            <Bar yAxisId="left" dataKey="Total"     fill="#1B1A36" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="left" dataKey="Connected" fill="#94A3B8" radius={[3, 3, 0, 0]} />
            <Line yAxisId="right" dataKey="Conn. rate"     stroke="#E8345C" strokeWidth={2} dot={{ r: 3 }} />
            <Line yAxisId="right" dataKey="Interest rate"  stroke="#10B981" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
