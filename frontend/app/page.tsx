'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Phone } from 'lucide-react';

import FilterBar from '@/components/filters/filter-bar';
import MetricCard from '@/components/ui/metric-card';
import CallsOverTime from '@/components/charts/calls-over-time';
import FunnelChart, { FunnelStageKey } from '@/components/charts/funnel';
import VendorBars from '@/components/charts/vendor-bars';
import OutcomeDistribution from '@/components/charts/outcome-distribution';
import AttemptsDistribution from '@/components/charts/attempts-distribution';
import ConnectedBreakdown from '@/components/charts/connected-breakdown';
import UnreachedBreakdown from '@/components/charts/unreached-breakdown';
import DuplicateLeadsCard from '@/components/ui/duplicate-leads-card';
import InsightsPanel from '@/components/ui/insights-panel';
import FunnelStageDrawer from '@/components/calls/funnel-stage-drawer';
import CallDetailDrawer from '@/components/calls/call-detail-drawer';
import { api, fmt } from '@/lib/api';
import { overviewInsights } from '@/lib/insights';
import type { Filters } from '@/types';

const initialFilters: Filters = {
  start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  end: new Date(),
  vendor_ids: [],
  campaign_ids: [],
};

// Build a /calls deep-link that carries the current date window
function buildCallsLink(filters: Filters, params: Record<string, string>): string {
  const q = new URLSearchParams({
    start: filters.start.toISOString(),
    end: filters.end.toISOString(),
    ...params,
  });
  return `/calls?${q.toString()}`;
}

// Tooltip definitions — single source of truth, every tile carries one.
const T = {
  uniqueLeads:  'Distinct phone numbers dialed in this window. Same person dialed in 5 attempts across 2 campaigns = 1 lead. The universe everything else funnels from.',
  dialAttempts: 'Total dial attempts including retries. A lead dialed 5 times = 5. This is what the vendor bills for — separate from "people reached".',
  connected:    'Lead-attempts where a human picked up AND the call completed. Excludes voicemail (answered_by=MACHINE) and dropped calls.',
  interested:   'Connected leads tagged HIGH or MEDIUM by Hunar\'s interest_level classifier. The qualified-intent pool. Click to inspect.',
  callback:     'Connected leads who explicitly asked for a callback (next_step_interest=CALLBACK). Independent of interest_level — some are also Interested, some aren\'t.',
  topPriority:  'Leads who are BOTH Interested (HIGH/MEDIUM) AND asked for callback. The lowest-noise sales-actionable list. Call these first.',
  engaged:      'Connected leads who actively engaged in conversation (engagement_status=ENGAGED). Different from interested — engagement = stayed on the call.',
  avgDur:       'Average length of connected calls only. Failed/voicemail/dropped calls excluded so it reflects real conversations.',
  unreached:    'Lead-attempts we did NOT connect with. Includes In Progress (still being retried — Hunar isn\'t done yet), Not Connected, Voicemail, and hard Failed.',
};

export default function OverviewPage() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [stage, setStage] = useState<{ key: FunnelStageKey; label: string } | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  const metrics  = useQuery({ queryKey: ['metrics', filters],  queryFn: () => api.overviewMetrics(filters) });
  const series   = useQuery({ queryKey: ['series', filters],   queryFn: () => api.timeSeries(filters) });
  const funnel   = useQuery({ queryKey: ['funnel', filters],   queryFn: () => api.funnel(filters) });
  const vcomp    = useQuery({ queryKey: ['vcomp', filters],    queryFn: () => api.vendorComparison(filters) });
  const outcomes = useQuery({ queryKey: ['outcomes', filters], queryFn: () => api.outcomes(filters) });
  const attempts = useQuery({ queryKey: ['attempts', filters], queryFn: () => api.attemptsDistribution(filters) });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const insights = overviewInsights(metrics.data, funnel.data, vcomp.data, series.data);

  const m = metrics.data;

  // The two callback subsets — useful for the sibling card under the funnel.
  // both = unique_top_priority_leads (Interested AND Callback) — sales A-tier
  // only = unique_callback_only_leads (Callback NOT Interested) — sales B-tier extras
  const cbBoth = m?.unique_top_priority_leads ?? 0;
  const cbOnly = m?.unique_callback_only_leads ?? 0;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Overview</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Unified analytics across all AI calling vendors. Tap any (i) for definitions.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      {/* Row 1 — Reach side of the funnel.
          Unique Leads is the headline; Dial Attempts (different unit) is
          surfaced for cost analysis but not as the headline. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <MetricCard
          label="Unique leads"
          value={m ? fmt.int(m.unique_leads) : '—'}
          hint={m ? `${fmt.int(m.unique_connected_leads)} reached · ${fmt.int(m.unique_interested_leads)} interested` : undefined}
          tooltip={T.uniqueLeads}
          accent
        />
        <MetricCard
          label="Dial attempts"
          value={m ? fmt.int(m.total_calls) : '—'}
          hint={m && m.unique_leads > 0 ? `${m.attempts_per_lead.toFixed(2)} per lead (incl. retries)` : undefined}
          tooltip={T.dialAttempts}
        />
        <MetricCard
          label="Connected"
          value={m ? fmt.int(m.unique_connected_leads) : '—'}
          hint={m ? `${fmt.pct(m.unique_leads ? m.unique_connected_leads / m.unique_leads : 0)} of leads` : undefined}
          tooltip={T.connected}
          href={buildCallsLink(filters, { funnel_stage: 'connected' })}
        />
        <MetricCard
          label="Engaged"
          value={m ? fmt.int(m.unique_engaged_leads) : '—'}
          hint={m && m.unique_connected_leads > 0 ? `${fmt.pct(m.unique_engaged_leads / m.unique_connected_leads)} of connected` : undefined}
          tooltip={T.engaged}
          href={buildCallsLink(filters, { funnel_stage: 'engaged' })}
        />
      </div>

      {/* Row 2 — Intent signals. Interested and Callback are PARALLEL, not nested.
          Top Priority = both = the actionable A-tier list. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <MetricCard
          label="Interested (H/M)"
          value={m ? fmt.int(m.unique_interested_leads) : '—'}
          hint={m && m.unique_connected_leads > 0 ? `${fmt.pct(m.unique_interested_leads / m.unique_connected_leads)} of connected` : undefined}
          tooltip={T.interested}
          href={buildCallsLink(filters, { funnel_stage: 'interested' })}
        />
        <MetricCard
          label="Wants callback"
          value={m ? fmt.int(m.unique_callback_leads) : '—'}
          hint={m && m.unique_connected_leads > 0 ? `${fmt.pct(m.unique_callback_leads / m.unique_connected_leads)} of connected` : undefined}
          tooltip={T.callback}
          href={buildCallsLink(filters, { funnel_stage: 'callback' })}
        />
        <MetricCard
          label="Top priority"
          value={m ? fmt.int(m.unique_top_priority_leads) : '—'}
          hint={m ? 'Interested AND Callback' : undefined}
          tooltip={T.topPriority}
          href={buildCallsLink(filters, { funnel_stage: 'top_priority' })}
          accent
        />
        <MetricCard
          label="Avg. duration"
          value={m ? fmt.duration(m.avg_duration_seconds) : '—'}
          hint="Connected calls only"
          tooltip={T.avgDur}
        />
      </div>

      {/* Calls-over-time + Funnel side-by-side. Funnel is the visual centerpiece. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
        <div className="lg:col-span-2">
          <CallsOverTime data={series.data || []} />
        </div>
        <FunnelChart
          data={funnel.data || []}
          totalDials={m?.total_calls ?? null}
          onStageClick={(key, label) => setStage({ key, label })}
        />
      </div>

      {/* Callback sibling card — surfaces the 65 leads who asked for a callback
          but aren't HIGH/MEDIUM interest. These are sales-actionable but would
          be hidden if the funnel only showed Interested. */}
      {m && m.unique_callback_leads > 0 && (
        <div className="card p-5">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
              <Phone size={14} className="text-brand-pink" />
              Callback list · {fmt.int(m.unique_callback_leads)}
            </h3>
            <span className="text-[11px] text-surface-500">independent signal — not in funnel</span>
          </div>
          <p className="text-xs text-surface-500 mb-3">
            Leads who explicitly asked to be called back. Some are also Interested
            (overlap with funnel), some aren't (would be missed otherwise).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <a
              href={buildCallsLink(filters, { funnel_stage: 'top_priority' })}
              className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3 hover:bg-emerald-50 transition-colors block"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-800">
                Also Interested
              </div>
              <div className="mt-1 text-xl font-semibold text-brand-navy tabular-nums">
                {fmt.int(cbBoth)}
              </div>
              <div className="text-[11px] text-surface-500 mt-0.5">
                A-tier · already counted in the funnel
              </div>
            </a>
            <a
              href={buildCallsLink(filters, { funnel_stage: 'callback_only' })}
              className="rounded-md border border-amber-200 bg-amber-50/50 p-3 hover:bg-amber-50 transition-colors block"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-amber-800">
                Callback only
              </div>
              <div className="mt-1 text-xl font-semibold text-brand-navy tabular-nums">
                {fmt.int(cbOnly)}
              </div>
              <div className="text-[11px] text-surface-500 mt-0.5">
                B-tier · low/unclear interest but asked anyway
              </div>
            </a>
          </div>
        </div>
      )}

      {/* Connected breakdown + Unreached breakdown — side by side.
          Together they account for every single lead-attempt in the slice
          (no data hidden, no double-counting). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <ConnectedBreakdown
          data={m?.connected_breakdown}
          total={m?.connected_calls}
          filters={filters}
        />
        <UnreachedBreakdown
          data={m?.unreached_breakdown}
          total={m?.unreached_total}
        />
      </div>

      {/* Cross-campaign duplicates — auto-hides when count is 0 (e.g. when
          the user filters to a single campaign, where duplicates can't exist). */}
      {m && m.duplicate_leads > 0 && (
        <DuplicateLeadsCard
          count={m.duplicate_leads}
          rows={m.duplicate_rows}
          dialAttempts={m.duplicate_dial_attempts}
          campaigns={m.duplicate_campaigns ?? []}
        />
      )}

      <OutcomeDistribution data={outcomes.data} isLoading={outcomes.isLoading} />

      <AttemptsDistribution data={attempts.data} isLoading={attempts.isLoading} />

      <InsightsPanel
        insights={insights}
        subtitle="Auto-generated observations from this date range"
      />

      <VendorBars data={vcomp.data || []} metric="connection_rate" />

      <FunnelStageDrawer
        filters={filters}
        stage={stage?.key || null}
        stageLabel={stage?.label || ''}
        onClose={() => setStage(null)}
        onCallClick={(id) => setSelectedCallId(id)}
      />

      <CallDetailDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
    </div>
  );
}
