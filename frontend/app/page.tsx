'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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

// Build a /calls deep-link that carries the FULL filter state — date window
// plus vendor/campaign selections plus any extra params (funnel_stage, etc.)
// the caller wants to layer on. Without this, clicking a tile while a single
// vendor is selected would silently widen the calls page back to "all vendors".
function buildCallsLink(filters: Filters, params: Record<string, string>): string {
  const q = new URLSearchParams({
    start: filters.start.toISOString(),
    end: filters.end.toISOString(),
    ...params,
  });
  // Repeated params (?vendor_ids=a&vendor_ids=b) — matches what filtersFromUrl
  // expects on the receiving side via URLSearchParams.getAll.
  for (const v of (filters.vendor_ids || [])) q.append('vendor_ids', v);
  for (const c of (filters.campaign_ids || [])) q.append('campaign_ids', c);
  return `/calls?${q.toString()}`;
}

// Tooltip definitions — single source of truth, every tile carries one.
const T = {
  uniqueLeads:    'Distinct phone numbers dialed in this window. Same person dialed in 5 attempts across 2 campaigns = 1 lead. The universe everything else funnels from. The hint shows total dial attempts including retries — different unit, used for cost analysis.',
  connected:      'Leads we actually reached — at least one attempt completed with a HUMAN pickup. Excludes voicemail (answered_by=MACHINE), in-progress retries, and hard failures.',
  engaged:        'Connected leads who had a real back-and-forth with the bot (engagement_status=ENGAGED on at least one attempt). Quality gate — tells you whether the bot got a fair listen, not whether the prospect was interested.',
  avgDur:         'Average length of connected calls only. Failed/voicemail/dropped calls excluded so it reflects real conversations.',
  // Sales action buckets — each connected lead lands in exactly one
  topPriority:    'Connected AND tagged HIGH/MEDIUM interest AND asked for callback. The lowest-noise sales-actionable list. Call these first.',
  interestedOnly: 'Tagged HIGH/MEDIUM interest BUT did NOT ask for a callback. Warm leads — sales should still chase, but priority below Top.',
  callbackOnly:   'Asked for a callback BUT interest tagged LOW / NOT_COVERED / NOT_AVAILABLE. They want contact even though the bot didn\'t qualify them — give them a shot but don\'t expect the same hit-rate as Interested.',
  noIntent:       'Connected, had the conversation, but no positive signal — said no, bot couldn\'t qualify, or call ended too short. Useful for QA: listen to a sample to see if the bot\'s pitch is the issue.',
  unreached:      'Lead-attempts we did NOT connect with. Includes In Progress (still being retried — Hunar isn\'t done yet), Not Connected, Voicemail, and hard Failed.',
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

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Overview</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Unified analytics across all AI calling vendors. Tap any (i) for definitions.
        </p>
      </header>

      <FilterBar filters={filters} onChange={setFilters} onExport={handleExport} />

      {/* ── Row 1 ─────────────────────────────────────────────────────────
          Funnel basics: the 3 stages of the funnel + Avg duration as a
          conversation quality indicator. Hyperlink each tile to /calls
          filtered to that stage so anyone can drill in instantly.        */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <MetricCard
          label="Unique leads"
          value={m ? fmt.int(m.unique_leads) : '—'}
          hint={m ? `${fmt.int(m.total_calls)} dial attempts (${m.attempts_per_lead.toFixed(1)}/lead)` : undefined}
          tooltip={T.uniqueLeads}
          accent
        />
        <MetricCard
          label="Connected"
          value={m ? fmt.int(m.unique_connected_leads) : '—'}
          hint={m && m.unique_leads ? `${fmt.pct(m.unique_connected_leads / m.unique_leads)} of leads` : undefined}
          tooltip={T.connected}
          href={buildCallsLink(filters, { funnel_stage: 'connected' })}
        />
        <MetricCard
          label="Engaged"
          value={m ? fmt.int(m.unique_engaged_leads) : '—'}
          hint={m && m.unique_connected_leads ? `${fmt.pct(m.unique_engaged_leads / m.unique_connected_leads)} of connected` : undefined}
          tooltip={T.engaged}
          href={buildCallsLink(filters, { funnel_stage: 'engaged' })}
        />
        <MetricCard
          label="Avg. duration"
          value={m ? fmt.duration(m.avg_duration_seconds) : '—'}
          hint="Connected calls only"
          tooltip={T.avgDur}
        />
      </div>

      {/* ── Row 2 — Sales action breakdown ────────────────────────────────
          Every Connected lead lands in EXACTLY ONE of these four buckets.
          Sum equals Connected (within ~2 unclassified). Each card is a
          clickable filter so a sales/QA person can pull that exact list.
          Top Priority is highlighted (accent) — call these first.        */}
      <div className="card p-4 md:p-5">
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-sm font-semibold text-brand-navy">
            Sales action breakdown
            {m && (
              <span className="text-surface-500 font-normal ml-2">
                · {fmt.int(m.unique_connected_leads)} connected leads, sliced into 4 mutually exclusive buckets
              </span>
            )}
          </h3>
        </div>
        <p className="text-xs text-surface-500 mb-4">
          Each connected lead is in exactly one bucket. Top Priority is your A-tier — work those first. Click any card to see the leads.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <MetricCard
            label="Top priority"
            value={m ? fmt.int(m.unique_top_priority_leads) : '—'}
            hint="Interested AND Callback"
            tooltip={T.topPriority}
            href={buildCallsLink(filters, { funnel_stage: 'top_priority' })}
            accent
          />
          <MetricCard
            label="Interested only"
            value={m ? fmt.int(m.unique_interested_only_leads) : '—'}
            hint="HIGH/MEDIUM, no callback ask"
            tooltip={T.interestedOnly}
            href={buildCallsLink(filters, { funnel_stage: 'interested_only' })}
          />
          <MetricCard
            label="Callback only"
            value={m ? fmt.int(m.unique_callback_only_leads) : '—'}
            hint="Asked callback, low/unclear interest"
            tooltip={T.callbackOnly}
            href={buildCallsLink(filters, { funnel_stage: 'callback_only' })}
          />
          <MetricCard
            label="No intent"
            value={m ? fmt.int(m.unique_no_intent_leads) : '—'}
            hint="Connected but said no / not covered"
            tooltip={T.noIntent}
            href={buildCallsLink(filters, { funnel_stage: 'no_intent' })}
          />
        </div>
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
