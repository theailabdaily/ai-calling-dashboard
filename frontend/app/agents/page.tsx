'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import FilterBar from '@/components/filters/filter-bar';
import { api, fmt } from '@/lib/api';
import type { AgentPerformanceRow, Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

const SORT_OPTIONS = [
  { key: 'total_calls',      label: 'Volume' },
  { key: 'connection_rate',  label: 'Connection rate' },
  { key: 'engagement_rate',  label: 'Engagement rate' },
  { key: 'interest_rate',    label: 'Interest rate' },
  { key: 'follow_up_rate',   label: 'Follow-up rate' },
] as const;

type SortKey = typeof SORT_OPTIONS[number]['key'];

export default function AgentsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [sortBy, setSortBy] = useState<SortKey>('interest_rate');

  const perf = useQuery({
    queryKey: ['agent-perf', filters],
    queryFn: () => api.agentPerformance(filters),
  });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');

  const sorted: AgentPerformanceRow[] = [...(perf.data || [])].sort(
    (a, b) => (b[sortBy] as number) - (a[sortBy] as number)
  );

  const chartData = sorted.slice(0, 10).map(r => ({
    name: r.agent_name.length > 20 ? r.agent_name.slice(0, 18) + '…' : r.agent_name,
    'Connection': +(r.connection_rate * 100).toFixed(1),
    'Interest':   +(r.interest_rate * 100).toFixed(1),
  }));

  return (
    <div className="p-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Agent performance</h1>
        <p className="text-sm text-surface-500 mt-1">
          Which AI script and persona converts best. Sort by any metric.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      {/* Top-10 chart */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-brand-navy mb-1">Top 10 agents</h3>
        <p className="text-xs text-surface-500 mb-4">
          Connection vs interest rate. The gap between the two tells you whether a script <em>opens</em>
          {' '}well but doesn't <em>convert</em>.
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E8EE" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6B7280' }} interval={0} angle={-15} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11, fill: '#6B7280' }} unit="%" />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #E5E8EE', fontSize: 12 }}
                formatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <Bar dataKey="Connection" fill="#1B1A36" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Interest"   fill="#E8345C" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Sort + table */}
      <div className="card p-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-surface-700 mr-2">Sort by:</span>
        {SORT_OPTIONS.map(o => (
          <button
            key={o.key}
            onClick={() => setSortBy(o.key)}
            className={sortBy === o.key ? 'btn bg-brand-navy text-white' : 'btn-outline'}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
                <th className="px-5 py-3 font-medium">Agent</th>
                <th className="px-3 py-3 font-medium">Vendor</th>
                <th className="px-3 py-3 font-medium">Lang / Voice</th>
                <th className="px-3 py-3 font-medium text-right">Calls</th>
                <th className="px-3 py-3 font-medium text-right">Connected</th>
                <th className="px-3 py-3 font-medium text-right">Conn. rate</th>
                <th className="px-3 py-3 font-medium text-right">Avg. dur.</th>
                <th className="px-3 py-3 font-medium text-right">Engaged</th>
                <th className="px-3 py-3 font-medium text-right">Interest</th>
                <th className="px-5 py-3 font-medium text-right">Follow-up</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(a => (
                <tr key={a.agent_id} className="border-t border-surface-100 hover:bg-surface-50">
                  <td className="px-5 py-3 font-medium text-brand-navy max-w-[260px] truncate" title={a.agent_name}>
                    {a.agent_name}
                  </td>
                  <td className="px-3 py-3 text-xs text-surface-700">{a.vendor_name}</td>
                  <td className="px-3 py-3 text-xs text-surface-500">
                    {a.language || '—'}{a.voice_persona ? ` · ${a.voice_persona}` : ''}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmt.int(a.total_calls)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmt.int(a.connected_calls)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium">{fmt.pct(a.connection_rate)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmt.duration(a.avg_duration_seconds)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{fmt.pct(a.engagement_rate)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium text-brand-pink">{fmt.pct(a.interest_rate)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt.pct(a.follow_up_rate)}</td>
                </tr>
              ))}
              {!sorted.length && (
                <tr><td colSpan={10} className="text-center py-8 text-surface-500 text-sm">
                  No agent data yet — run a sync to pull agents from the vendor.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
