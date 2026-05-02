'use client';
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Megaphone } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { CampaignHourSplit, HourBucket } from '@/types';

type Props = { data: CampaignHourSplit[] };

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

export default function HourByCampaign({ data }: Props) {
  if (!data.length) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Hour split by campaign</h3>
        <div className="text-xs text-surface-500 py-8 text-center">No campaign data in this window.</div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-brand-navy mb-1 flex items-center gap-1.5">
        <Megaphone size={14} className="text-brand-pink" />
        Hour split by campaign (IST)
      </h3>
      <p className="text-xs text-surface-500 mb-4">
        Top {data.length} campaign{data.length !== 1 ? 's' : ''} by volume. Different audiences answer at different times.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.map(c => {
          const filled = fillHours(c.hours);
          const rows = filled.map(b => ({
            hour: hourLabel(b.hour),
            Total: b.total_calls,
            'Conn %': +(b.connection_rate * 100).toFixed(1),
          }));
          const totalCalls = c.hours.reduce((s, b) => s + b.total_calls, 0);
          const peak = [...c.hours].filter(h => h.total_calls >= 20)
            .sort((a, b) => b.connection_rate - a.connection_rate)[0];

          return (
            <div key={c.campaign_id} className="bg-surface-50 rounded-lg p-3 border border-surface-100">
              <div className="mb-2">
                <div className="text-xs font-medium text-brand-navy line-clamp-2 leading-snug">
                  {c.display_name || c.campaign_name}
                </div>
                <div className="text-[10px] text-surface-500 mt-0.5">
                  {fmt.int(totalCalls)} calls
                  {peak && ` · peak ${hourLabel(peak.hour)} (${fmt.pct(peak.connection_rate)})`}
                </div>
              </div>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 2, right: 2, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
                    <XAxis dataKey="hour" tick={{ fontSize: 8, fill: '#6B7280' }} interval={3} />
                    <YAxis yAxisId="left" tick={{ fontSize: 8, fill: '#6B7280' }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 8, fill: '#6B7280' }} unit="%" />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="Total" fill="#1B1A36" radius={[2, 2, 0, 0]} />
                    <Line yAxisId="right" dataKey="Conn %" stroke="#E8345C" strokeWidth={1.5} dot={{ r: 2 }} />
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
