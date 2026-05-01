'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import FilterBar from '@/components/filters/filter-bar';
import MetricCard from '@/components/ui/metric-card';
import CallsOverTime from '@/components/charts/calls-over-time';
import FunnelChart from '@/components/charts/funnel';
import VendorBars from '@/components/charts/vendor-bars';
import { api, fmt } from '@/lib/api';
import type { Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

export default function OverviewPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);

  const metrics = useQuery({ queryKey: ['metrics', filters], queryFn: () => api.overviewMetrics(filters) });
  const series  = useQuery({ queryKey: ['series', filters],  queryFn: () => api.timeSeries(filters) });
  const funnel  = useQuery({ queryKey: ['funnel', filters],  queryFn: () => api.funnel(filters) });
  const vcomp   = useQuery({ queryKey: ['vcomp', filters],   queryFn: () => api.vendorComparison(filters) });

  const handleExport = () => {
    window.open(api.exportCallsUrl(filters), '_blank');
  };

  return (
    <div className="p-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Overview</h1>
        <p className="text-sm text-surface-500 mt-1">
          Unified analytics across all AI calling vendors
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      {/* Top-level metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Total calls"
          value={metrics.data ? fmt.int(metrics.data.total_calls) : '—'}
          accent
        />
        <MetricCard
          label="Connected"
          value={metrics.data ? fmt.int(metrics.data.connected_calls) : '—'}
          hint={metrics.data ? `${fmt.pct(metrics.data.connection_rate)} connection rate` : undefined}
        />
        <MetricCard
          label="Avg. duration"
          value={metrics.data ? fmt.duration(metrics.data.avg_duration_seconds) : '—'}
          hint="Connected calls only"
        />
        <MetricCard
          label="Conversion"
          value={metrics.data ? fmt.pct(metrics.data.conversion_rate) : '—'}
          hint={metrics.data ? `${fmt.int(metrics.data.interested_calls)} interested / ${fmt.int(metrics.data.total_calls)} dialed` : undefined}
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Engagement rate" value={metrics.data ? fmt.pct(metrics.data.engagement_rate) : '—'} />
        <MetricCard label="Interest rate"   value={metrics.data ? fmt.pct(metrics.data.interest_rate) : '—'} />
        <MetricCard label="Follow-up rate"  value={metrics.data ? fmt.pct(metrics.data.follow_up_rate) : '—'} />
        <MetricCard label="Failed calls"    value={metrics.data ? fmt.int(metrics.data.failed_calls) : '—'} />
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <CallsOverTime data={series.data || []} />
        </div>
        <FunnelChart data={funnel.data || []} />
      </div>

      <VendorBars data={vcomp.data || []} metric="connection_rate" />
    </div>
  );
}
