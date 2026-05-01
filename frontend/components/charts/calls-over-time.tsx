'use client';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';
import type { TimeBucket } from '@/types';

type Props = { data: TimeBucket[] };

export default function CallsOverTime({ data }: Props) {
  const formatted = data.map(d => ({
    ...d,
    label: d.bucket ? format(parseISO(d.bucket), 'd MMM') : '',
  }));

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-brand-navy mb-1">Calls over time</h3>
      <p className="text-xs text-surface-500 mb-4">Total dialed vs connected vs interested</p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={formatted} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1B1A36" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#1B1A36" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gConn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#E8345C" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#E8345C" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6B7280' }} />
            <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }}
              labelStyle={{ color: '#1B1A36', fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="total" stroke="#1B1A36" fill="url(#gTotal)" name="Total" />
            <Area type="monotone" dataKey="connected" stroke="#E8345C" fill="url(#gConn)" name="Connected" />
            <Area type="monotone" dataKey="interested" stroke="#10B981" fill="transparent" name="Interested" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
