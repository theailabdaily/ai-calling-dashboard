// Pure data → insights logic. Each page calls the relevant function.
// Insights are data-driven, not generic — they reference real numbers from the dataset.

import type {
  AgentPerformanceRow, CampaignRow, CallListPage, FunnelStage, HourlyInsights,
  OverviewMetrics, TimeBucket, VendorRow,
} from '@/types';
import type { Insight } from '@/components/ui/insights-panel';

const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const intf = (n: number) => new Intl.NumberFormat('en-IN').format(Math.round(n));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export function overviewInsights(
  metrics: OverviewMetrics | undefined,
  funnel: FunnelStage[] | undefined,
  vcomp: VendorRow[] | undefined,
  series: TimeBucket[] | undefined,
): Insight[] {
  if (!metrics || !funnel) return [];
  const out: Insight[] = [];

  // 1. Connection rate health (industry benchmark: ~30-45% for outbound EdTech)
  const cr = metrics.connection_rate;
  if (metrics.total_calls > 0) {
    if (cr >= 0.40) {
      out.push({
        tone: 'positive',
        title: `Connection rate is strong at ${pct(cr)}`,
        detail: `${intf(metrics.connected_calls)} of ${intf(metrics.total_calls)} dialed picked up by a human. Above the 30–40% outbound benchmark.`,
      });
    } else if (cr >= 0.30) {
      out.push({
        tone: 'neutral',
        title: `Connection rate ${pct(cr)} — within range`,
        detail: `${intf(metrics.connected_calls)} of ${intf(metrics.total_calls)} dialed connected. Outbound EdTech typically sees 30–45%.`,
      });
    } else {
      out.push({
        tone: 'warning',
        title: `Connection rate is low at ${pct(cr)}`,
        detail: `Only ${intf(metrics.connected_calls)} of ${intf(metrics.total_calls)} dialed picked up. Investigate caller ID, dial timing, or list quality.`,
      });
    }
  }

  // 2. Funnel biggest drop-off
  if (funnel.length >= 2) {
    let worstDrop = 0;
    let worstPair: [FunnelStage, FunnelStage] | null = null;
    for (let i = 1; i < funnel.length; i++) {
      const prev = funnel[i - 1].count;
      const curr = funnel[i].count;
      if (prev > 0) {
        const drop = (prev - curr) / prev;
        if (drop > worstDrop) {
          worstDrop = drop;
          worstPair = [funnel[i - 1], funnel[i]];
        }
      }
    }
    if (worstPair && worstDrop >= 0.40) {
      out.push({
        tone: 'warning',
        title: `Biggest drop-off: ${worstPair[0].stage} → ${worstPair[1].stage}`,
        detail: `${pct(worstDrop)} of leads fall off here (${intf(worstPair[0].count)} → ${intf(worstPair[1].count)}). Highest-leverage place to improve.`,
      });
    }
  }

  // 3. Best/worst vendor on connection (only if multiple vendors)
  if (vcomp && vcomp.length >= 2) {
    const significant = vcomp.filter(v => v.total_calls >= 50);
    if (significant.length >= 2) {
      const sorted = [...significant].sort((a, b) => b.connection_rate - a.connection_rate);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (best.connection_rate - worst.connection_rate >= 0.10) {
        out.push({
          tone: 'info',
          title: `${best.vendor_name} beats ${worst.vendor_name} by ${pct(best.connection_rate - worst.connection_rate)} on connection`,
          detail: `${pct(best.connection_rate)} vs ${pct(worst.connection_rate)}. Shift volume toward ${best.vendor_name} or investigate ${worst.vendor_name} setup.`,
        });
      }
    }
  }

  // 4. Volume trend
  if (series && series.length >= 7) {
    const recent = series.slice(-3).reduce((s, b) => s + b.total, 0);
    const prior = series.slice(-6, -3).reduce((s, b) => s + b.total, 0);
    if (prior > 0 && recent / prior <= 0.5) {
      out.push({
        tone: 'warning',
        title: 'Calling volume dropped sharply in the last 3 days',
        detail: `${intf(recent)} calls in last 3d vs ${intf(prior)} in the prior 3d. Check vendor sync, campaign status, or list exhaustion.`,
      });
    } else if (prior > 0 && recent / prior >= 1.5) {
      out.push({
        tone: 'info',
        title: 'Calling volume is ramping up',
        detail: `${intf(recent)} calls in last 3d vs ${intf(prior)} in the prior 3d. Monitor connection rate to ensure quality holds.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Vendor analysis
// ---------------------------------------------------------------------------
export function vendorInsights(vcomp: VendorRow[] | undefined, campaigns: CampaignRow[] | undefined): Insight[] {
  if (!vcomp || vcomp.length === 0) return [];
  const out: Insight[] = [];

  const significant = vcomp.filter(v => v.total_calls >= 30);

  // 1. Best performer summary
  if (significant.length >= 1) {
    const best = [...significant].sort((a, b) => b.interest_rate - a.interest_rate)[0];
    out.push({
      tone: 'positive',
      title: `${best.vendor_name} leads on interest rate at ${pct(best.interest_rate)}`,
      detail: `${intf(best.connected_calls)} connected calls produced ${pct(best.interest_rate)} qualified leads. Strongest funnel quality.`,
    });
  }

  // 2. Volume vs quality tension — high volume, low interest
  for (const v of significant) {
    if (v.total_calls >= 100 && v.interest_rate < 0.10 && v.connection_rate >= 0.30) {
      out.push({
        tone: 'warning',
        title: `${v.vendor_name}: high volume but low conversion`,
        detail: `${intf(v.total_calls)} calls, ${pct(v.connection_rate)} connection — but only ${pct(v.interest_rate)} interest rate on connected. Audit script or audience match.`,
      });
    }
  }

  // 3. Vendor comparison gap
  if (significant.length >= 2) {
    const sorted = [...significant].sort((a, b) => b.connection_rate - a.connection_rate);
    const gap = sorted[0].connection_rate - sorted[sorted.length - 1].connection_rate;
    if (gap >= 0.15) {
      out.push({
        tone: 'info',
        title: `Connection-rate gap across vendors is ${pct(gap)}`,
        detail: `${sorted[0].vendor_name} (${pct(sorted[0].connection_rate)}) materially outperforms ${sorted[sorted.length - 1].vendor_name} (${pct(sorted[sorted.length - 1].connection_rate)}). Worth investigating root cause.`,
      });
    }
  }

  // 4. Campaign concentration risk
  if (campaigns && campaigns.length >= 1) {
    const totalAcrossCampaigns = campaigns.reduce((s, c) => s + c.total_calls, 0);
    const top = [...campaigns].sort((a, b) => b.total_calls - a.total_calls)[0];
    if (totalAcrossCampaigns > 0 && top.total_calls / totalAcrossCampaigns >= 0.7) {
      out.push({
        tone: 'neutral',
        title: `One campaign accounts for ${pct(top.total_calls / totalAcrossCampaigns)} of all calls`,
        detail: `"${top.display_name || top.campaign_name}" — ${intf(top.total_calls)} of ${intf(totalAcrossCampaigns)}. Diversify or be aware insights reflect this single audience.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Agent performance
// ---------------------------------------------------------------------------
export function agentInsights(rows: AgentPerformanceRow[] | undefined): Insight[] {
  if (!rows || rows.length === 0) return [];
  const out: Insight[] = [];

  const significant = rows.filter(r => r.total_calls >= 30);
  if (significant.length === 0) {
    out.push({
      tone: 'neutral',
      title: 'Not enough call volume per agent yet',
      detail: 'Need at least 30 calls per agent before performance comparisons are meaningful.',
    });
    return out;
  }

  // 1. Best agent
  const sortedByInterest = [...significant].sort((a, b) => b.interest_rate - a.interest_rate);
  const best = sortedByInterest[0];
  out.push({
    tone: 'positive',
    title: `${best.agent_name} (${best.language || '—'}) leads on interest`,
    detail: `${pct(best.interest_rate)} interest rate on ${intf(best.connected_calls)} connected calls. ${best.voice_persona || 'Default voice'} — investigate what's working.`,
  });

  // 2. Underperformer flag
  if (significant.length >= 2) {
    const sortedByConn = [...significant].sort((a, b) => a.connection_rate - b.connection_rate);
    const worst = sortedByConn[0];
    const top = sortedByConn[sortedByConn.length - 1];
    if (top.connection_rate - worst.connection_rate >= 0.15) {
      out.push({
        tone: 'warning',
        title: `${worst.agent_name} connection rate is ${pct(worst.connection_rate)} — well below top performer`,
        detail: `${top.agent_name} hits ${pct(top.connection_rate)}. Could be voice/persona mismatch, script issue, or audience mismatch.`,
      });
    }
  }

  // 3. Language insight (if multiple languages active)
  const byLang = new Map<string, { calls: number; interested: number }>();
  for (const r of significant) {
    const l = r.language || 'unknown';
    const cur = byLang.get(l) || { calls: 0, interested: 0 };
    byLang.set(l, {
      calls: cur.calls + r.total_calls,
      interested: cur.interested + Math.round(r.interest_rate * r.connected_calls),
    });
  }
  if (byLang.size >= 2) {
    const langStats = [...byLang.entries()].map(([lang, s]) => ({
      lang,
      calls: s.calls,
      interest: s.calls > 0 ? s.interested / s.calls : 0,
    }));
    const sortedLang = langStats.sort((a, b) => b.interest - a.interest);
    if (sortedLang[0].interest - sortedLang[sortedLang.length - 1].interest >= 0.05) {
      out.push({
        tone: 'info',
        title: `${sortedLang[0].lang} is converting better than ${sortedLang[sortedLang.length - 1].lang}`,
        detail: `${pct(sortedLang[0].interest)} vs ${pct(sortedLang[sortedLang.length - 1].interest)} end-to-end interest rate. Skew capacity toward ${sortedLang[0].lang}.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Calls page (filtered list)
// ---------------------------------------------------------------------------
export function callsInsights(page: CallListPage | undefined): Insight[] {
  if (!page) return [];
  const out: Insight[] = [];

  // 1. Recording coverage
  const withRec = page.items.filter(c => c.has_recording).length;
  if (page.items.length > 0) {
    const cov = withRec / page.items.length;
    if (cov < 0.5) {
      out.push({
        tone: 'warning',
        title: `Only ${pct(cov)} of calls have recordings on this page`,
        detail: `${withRec} of ${page.items.length}. If recording is enabled, this gap suggests pickup failures or vendor issues. Check FAILED status calls.`,
      });
    } else if (cov >= 0.9) {
      out.push({
        tone: 'positive',
        title: `${pct(cov)} of calls on this page have recordings`,
        detail: 'Strong coverage. Recordings are available for QA and call review.',
      });
    }
  }

  // 2. Interested count visible
  const interested = page.items.filter(c => {
    if (!c.interested) return false;
    return ['yes', 'high', 'medium'].includes(c.interested.toLowerCase());
  }).length;
  if (page.items.length > 0 && interested >= 1) {
    out.push({
      tone: 'info',
      title: `${interested} interested lead${interested !== 1 ? 's' : ''} on this page`,
      detail: 'Click rows to inspect. Use filter "Interested only" to isolate them.',
    });
  }

  // 3. Page navigation hint when many pages
  if (page.total >= 100) {
    out.push({
      tone: 'neutral',
      title: `${intf(page.total)} calls match these filters`,
      detail: page.total > 1000
        ? 'Large dataset — narrow with date or vendor for faster review.'
        : `Showing page ${page.page} of ${Math.ceil(page.total / page.page_size)}.`,
    });
  }

  return out;
}


// ---------------------------------------------------------------------------
// Hourly Insights — narrative observations for the /hourly-insights page
// ---------------------------------------------------------------------------
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

const MIN_N = 30; // minimum sample to call a result "real"

export function hourlyInsights(data: HourlyInsights | undefined): Insight[] {
  if (!data) return [];
  const out: Insight[] = [];

  const totalCalls = data.hour_breakdown.reduce((s, h) => s + h.total_calls, 0);
  if (totalCalls === 0) {
    out.push({
      tone: 'neutral',
      title: 'No calls in this window',
      detail: 'Adjust the date range or filters to see hourly patterns.',
    });
    return out;
  }

  // 1. Calling-window concentration — flag if 100% of volume is in <=2 hours
  const sortedByVol = [...data.hour_breakdown].sort((a, b) => b.total_calls - a.total_calls);
  const top2Share = (sortedByVol.slice(0, 2).reduce((s, h) => s + h.total_calls, 0)) / totalCalls;
  if (top2Share > 0.9) {
    const hrs = sortedByVol.slice(0, 2).map(h => hourLabel(h.hour)).join(' & ');
    out.push({
      tone: 'warning',
      title: `${pct(top2Share)} of all calls are in just 2 hours (${hrs})`,
      detail: 'You\'re almost certainly leaving connections on the table outside this window. Test 1–2 adjacent hours to validate.',
    });
  }

  // 2. Best connection hour — only above MIN_N
  const significantHours = data.hour_breakdown.filter(h => h.total_calls >= MIN_N);
  if (significantHours.length >= 2) {
    const sortedConn = [...significantHours].sort((a, b) => b.connection_rate - a.connection_rate);
    const best = sortedConn[0];
    const worst = sortedConn[sortedConn.length - 1];
    const gap = best.connection_rate - worst.connection_rate;
    if (gap >= 0.05) {
      out.push({
        tone: 'positive',
        title: `${hourLabel(best.hour)} beats ${hourLabel(worst.hour)} by ${pct(gap)} on connection`,
        detail: `${pct(best.connection_rate)} vs ${pct(worst.connection_rate)} (${intf(best.total_calls)} vs ${intf(worst.total_calls)} calls). Shift volume toward ${hourLabel(best.hour)}.`,
      });
    }
  }

  // 3. Best DOW — must have >=2 days with significant volume
  const significantDows = data.dow_breakdown.filter(d => d.total_calls >= MIN_N);
  if (significantDows.length >= 2) {
    const bestDow = [...significantDows].sort((a, b) => b.connection_rate - a.connection_rate)[0];
    const worstDow = [...significantDows].sort((a, b) => a.connection_rate - b.connection_rate)[0];
    if (bestDow.dow !== worstDow.dow && bestDow.connection_rate - worstDow.connection_rate >= 0.05) {
      out.push({
        tone: 'positive',
        title: `${bestDow.dow_name} is your strongest day`,
        detail: `${pct(bestDow.connection_rate)} connection vs ${pct(worstDow.connection_rate)} on ${worstDow.dow_name}. Skew weekly capacity toward ${bestDow.dow_name}.`,
      });
    }
  }

  // 4. Heatmap sweet spot — single best cell with N >= MIN_N
  const significantCells = data.heatmap.filter(c => c.total_calls >= MIN_N);
  if (significantCells.length >= 2) {
    const bestCell = [...significantCells].sort((a, b) => b.connection_rate - a.connection_rate)[0];
    out.push({
      tone: 'info',
      title: `Sweet spot: ${bestCell.dow_name} ${hourLabel(bestCell.hour)}`,
      detail: `${pct(bestCell.connection_rate)} connection on ${intf(bestCell.total_calls)} calls — your single highest-converting time slot.`,
    });
  }

  // 5. Empty-cell observation — heatmap coverage
  const totalActiveCells = data.heatmap.length;
  const totalPossibleCells = 7 * 24;
  const coverage = totalActiveCells / totalPossibleCells;
  if (coverage < 0.1) {
    out.push({
      tone: 'neutral',
      title: `You've tested ${totalActiveCells} of 168 possible day×hour slots`,
      detail: `${pct(coverage)} coverage. The empty cells are unmeasured opportunity — you don\'t actually know what works at 7 PM Saturday because you've never tried.`,
    });
  }

  // 6. Interest vs connection mismatch — high pickup hour, low interest hour
  if (significantHours.length >= 2) {
    const bestConn = [...significantHours].sort((a, b) => b.connection_rate - a.connection_rate)[0];
    const bestInt = [...significantHours].sort((a, b) => b.interest_rate - a.interest_rate)[0];
    if (bestConn.hour !== bestInt.hour) {
      out.push({
        tone: 'info',
        title: `Pickup peak ≠ interest peak`,
        detail: `${hourLabel(bestConn.hour)} has the highest pickup (${pct(bestConn.connection_rate)}) but ${hourLabel(bestInt.hour)} has the most interested leads per connection (${pct(bestInt.interest_rate)}). Different audiences answer at different times.`,
      });
    }
  }

  return out;
}
