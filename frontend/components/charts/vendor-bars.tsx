'use client';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { VendorRow } from '@/types';

type Props = { data: VendorRow[]; metric?: 'connection_rate' | 'interest_rate' | 'engagement_rate' | 'follow_up_rate' };

const LABELS: Record<string, string> = {
  connection_rate: 'Connection rate',
  interest_rate: 'Interest rate',
  engagement_rate: 'Engagement rate',
  follow_up_rate: 'Follow-up rate',
};

export default function VendorBars({ data, metric = 'connection_rate' }: Props) {
  const formatted = data.map(d => ({
    name: d.vendor_name,
    [LABELS[metric]]: +(d[metric] * 100).toFixed(2),
  }));

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-brand-navy mb-1">Vendor performance</h3>
      <p className="text-xs text-surface-500 mb-4">{LABELS[metric]} across vendors</p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={formatted} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#6B7280' }} />
            <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} unit="%" />
            <Tooltip
              contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }}
              formatter={(v: number) => `${v.toFixed(1)}%`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey={LABELS[metric]} fill="#E8345C" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
