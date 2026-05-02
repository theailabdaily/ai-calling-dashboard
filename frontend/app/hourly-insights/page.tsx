'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import FilterBar from '@/components/filters/filter-bar';
import HourlyKpiStrip from '@/components/ui/hourly-kpi-strip';
import HeatmapDowHour from '@/components/charts/heatmap-dow-hour';
import HourDetail from '@/components/charts/hour-detail';
import DowChart from '@/components/charts/dow-chart';
import HourByVendor from '@/components/charts/hour-by-vendor';
import HourByCampaign from '@/components/charts/hour-by-campaign';
import InsightsPanel from '@/components/ui/insights-panel';
import { api } from '@/lib/api';
import { hourlyInsights as buildHourlyInsights } from '@/lib/insights';
import type { Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

export default function HourlyInsightsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);

  const insights = useQuery({
    queryKey: ['hourly-insights', filters],
    queryFn: () => api.hourlyInsights(filters),
  });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const data = insights.data;
  const narrative = buildHourlyInsights(data);

  return (
    <div className="p-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Hourly Insights</h1>
        <p className="text-sm text-surface-500 mt-1">
          When customers actually pick up — by hour, by weekday, by day×hour, by vendor, by campaign.
          All times in IST.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      {/* Top KPI strip */}
      <HourlyKpiStrip data={data?.hour_breakdown || []} />

      {/* Headline visual: 7×24 heatmap */}
      <HeatmapDowHour data={data?.heatmap || []} />

      {/* Hour rollup + DOW rollup, side by side on desktop */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <HourDetail data={data?.hour_breakdown || []} />
        <DowChart   data={data?.dow_breakdown  || []} />
      </div>

      {/* Per-vendor split */}
      <HourByVendor data={data?.by_vendor || []} />

      {/* Per-campaign split */}
      <HourByCampaign data={data?.by_campaign || []} />

      {/* Auto-narrative observations */}
      <InsightsPanel
        insights={narrative}
        subtitle="Auto-generated observations from this date range"
      />
    </div>
  );
}
