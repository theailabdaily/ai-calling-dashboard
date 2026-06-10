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
import { useRequireProductLine } from '@/lib/use-product-line';
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
  topPriority:    'Connected AND showed strong interest AND requested a follow-up (callback or counsellor call). Lowest-noise, highest-signal list. Call these first. For UGC NET: HIGH/MEDIUM interest + CALLBACK. For UPSC: counsellor_scheduled or (serious/exploratory + callback_requested).',
  interestedOnly: 'Showed strong interest BUT did NOT request a follow-up. Warm leads — BD should still chase, priority just below Top Priority. For UGC NET: HIGH/MEDIUM interest, no CALLBACK. For UPSC: serious/exploratory upsc_interest_status, no callback_requested.',
  callbackOnly:   'Requested a follow-up BUT interest signal was low or unclear. They want contact even though the bot didn\'t fully qualify them — worth a shot but expect lower hit-rate vs Interested. For UGC NET: CALLBACK next_step but LOW/NOT_COVERED interest. For UPSC: callback_requested call_outcome with unclear interest.',
  noIntent:       'Connected, had the conversation, but no positive signal — said no, bot couldn\'t qualify, or call ended too short. Useful for QA: listen to a sample to check if the bot\'s pitch or script is the issue.',
  unreached:      'Lead-attempts we did NOT connect with. Includes In Progress (still being retried — Hunar isn\'t done yet), Not Connected, Voicemail, and hard Failed.',
};

export default function OverviewPage() {
  const ready = useRequireProductLine();

  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [stage, setStage] = useState<{ key: FunnelStageKey; label: string } | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  const metrics  = useQuery({ queryKey: ['metrics', filters],  queryFn: () => api.overviewMetrics(filters), enabled: ready });
  const series   = useQuery({ queryKey: ['series', filters],   queryFn: () => api.timeSeries(filters),     enabled: ready });
  const funnel   = useQuery({ queryKey: ['funnel', filters],   queryFn: () => api.funnel(filters),         enabled: ready });
  const vcomp    = useQuery({ queryKey: ['vcomp', filters],    queryFn: () => api.vendorComparison(filters), enabled: ready });
  const outcomes = useQuery({ queryKey: ['outcomes', filters], queryFn: () => api.outcomes(filters),       enabled: ready });
  const attempts = useQuery({ queryKey: ['attempts', filters], queryFn: () => api.attemptsDistribution(filters), enabled: ready });

  const handleExport = () => window.open(api.exportCallsUrl(filters), '_blank');
  const insights = overviewInsights(metrics.data, funnel.data, vcomp.data, series.data);

  const m = metrics.data;

  // Don't render dashboard skeleton until we know which product line we're scoped to
  if (!ready) {
    return null;
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Overview</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Unified analytics across all AI calling vendors. The date range filters by
          when calls happened (call end date) — same as the Leads page. A campaign
          uploaded earlier still shows up if its dialer ran today. Tap any (i) for definitions.
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

      {/* ── Row 2 — Sales action breakdown (UGC) / Priority tiers (UPSC) ─────
          Every Connected lead lands in EXACTLY ONE card; the cards sum to
          Connected (zero overlap). On UPSC we show Yatin's Hot/Warm/Low
          priority cascade (+ Other catch-all); every other workspace keeps the
          original 4 buckets. The backend decides via `upsc_priority_tiers`. */}
      {m?.upsc_priority_tiers ? (
        <div className="card p-4 md:p-5">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="text-sm font-semibold text-brand-navy">
              Lead priority
              <span className="text-surface-500 font-normal ml-2">
                · {fmt.int(m.unique_connected_leads)} connected leads, one priority tier each
              </span>
            </h3>
          </div>
          <p className="text-xs text-surface-500 mb-4">
            Temperature ladder — work top-down. Each connected lead sits in exactly one tier. Tap any (i) for its definition. Hot &amp; Hot-Warm grow, Cold-Warm shrinks, as the agent&rsquo;s CRM capture improves.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            <MetricCard
              label="🔥 Hot"
              value={fmt.int(m.upsc_priority_tiers.hot)}
              hint="Engaged + clear buying signal"
              tooltip="Engaged AND a real buying signal was captured: interest = serious, OR a counsellor call was scheduled, OR a follow-up was requested. Call these first."
              accent
            />
            <MetricCard
              label="🟡 Hot Warm"
              value={fmt.int(m.upsc_priority_tiers.hot_warm)}
              hint="Engaged, long talk, full-time / side-by-side"
              tooltip="Not Hot, but engaged with a real conversation (>60s) and a full-time or side-by-side aspirant. Strong second priority — qualify and push to counsellor."
            />
            <MetricCard
              label="🟠 Cold Warm"
              value={fmt.int(m.upsc_priority_tiers.cold_warm)}
              hint="Engaged, but agent captured no signal"
              tooltip="Engaged — the lead had a genuine conversation — but the agent captured no qualifying signal (interest / counsellor / follow-up / prep). A human should re-qualify these; they are NOT low-value. This tier is large only because the agent's CRM capture is incomplete, and shrinks as it's fixed."
            />
            <MetricCard
              label="⚪ No Intent"
              value={fmt.int(m.upsc_priority_tiers.no_intent)}
              hint="Connected but never engaged"
              tooltip="Connected but never reached ENGAGED — picked up but no real conversation (mostly quick drops). No buying intent shown. Lowest priority."
            />
          </div>
        </div>
      ) : (
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
            hint="Interested AND requested follow-up"
            tooltip={T.topPriority}
            href={buildCallsLink(filters, { funnel_stage: 'top_priority' })}
            accent
          />
          <MetricCard
            label="Interested only"
            value={m ? fmt.int(m.unique_interested_only_leads) : '—'}
            hint="Interested, no follow-up ask"
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
      )}

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
