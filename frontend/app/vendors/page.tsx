'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import FilterBar from '@/components/filters/filter-bar';
import VendorBars from '@/components/charts/vendor-bars';
import VendorTable from '@/components/tables/vendor-table';
import CampaignTable from '@/components/tables/campaign-table';
import InsightsPanel from '@/components/ui/insights-panel';
import { api } from '@/lib/api';
import { vendorInsights } from '@/lib/insights';
import type { Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

const METRICS = [
  { key: 'connection_rate',  label: 'Connection rate' },
  { key: 'engagement_rate',  label: 'Engagement rate' },
  { key: 'interest_rate',    label: 'Interest rate' },
  { key: 'follow_up_rate',   label: 'Follow-up rate' },
] as const;

type MetricKey = typeof METRICS[number]['key'];

export default function VendorsPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [metric, setMetric] = useState<MetricKey>('connection_rate');

  const vcomp     = useQuery({ queryKey: ['vcomp', filters],     queryFn: () => api.vendorComparison(filters) });
  const cbreak    = useQuery({ queryKey: ['cbreak', filters],    queryFn: () => api.campaignBreakdown(filters) });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const insights = vendorInsights(vcomp.data, cbreak.data);

  return (
    <div className="p-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Vendor analysis</h1>
        <p className="text-sm text-surface-500 mt-1">
          Compare vendors side-by-side. Stack as many as you want via the Vendors filter.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      <InsightsPanel insights={insights} subtitle="Vendor + campaign-level observations" />

      <VendorTable data={vcomp.data || []} />

      {/* Metric selector for the bar chart */}
      <div className="card p-4 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-surface-700 mr-2">Compare on:</span>
        {METRICS.map(m => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={
              metric === m.key
                ? 'btn bg-brand-navy text-white'
                : 'btn-outline'
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      <VendorBars data={vcomp.data || []} metric={metric} />

      <CampaignTable data={cbreak.data || []} />
    </div>
  );
}
