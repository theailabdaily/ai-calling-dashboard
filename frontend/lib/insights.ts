// Pure data → insights logic. Each page calls the relevant function.
// Insights are data-driven, not generic — they reference real numbers from the dataset.

import type {
  AgentPerformanceRow, CampaignRow, CallListPage, FunnelStage,
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
    if (worstPair && worstDrop > 0.4) {
      out.push({
        tone: 'info',
        title: `Biggest drop-off: ${worstPair[0].stage} → ${worstPair[1].stage}`,
        detail: `${pct(worstDrop)} lost between these stages (${intf(worstPair[0].count)} → ${intf(worstPair[1].count)}). Likely the highest-leverage step to optimize.`,
      });
    }
  }

  // 3. Engaged → interested conversion (script effectiveness)
  if (metrics.engaged_calls > 0) {
    const engagedToInterested = metrics.interested_calls / metrics.engaged_calls;
    if (engagedToInterested < 0.4 && metrics.engaged_calls >= 20) {
      out.push({
        tone: 'warning',
        title: `Script opens but doesn't close`,
        detail: `${intf(metrics.engaged_calls)} engaged but only ${intf(metrics.interested_calls)} reached interested (${pct(engagedToInterested)}). Hook works, the pitch may not.`,
      });
    } else if (engagedToInterested >= 0.6 && metrics.engaged_calls >= 20) {
      out.push({
        tone: 'positive',
        title: `Strong engaged-to-interested conversion`,
        detail: `${pct(engagedToInterested)} of engaged calls reached interested. Script is converting well.`,
      });
    }
  }

  // 4. Vendor concentration
  if (vcomp && vcomp.length > 1) {
    const sorted = [...vcomp].sort((a, b) => b.total_calls - a.total_calls);
    const top = sorted[0];
    const totalAll = sorted.reduce((s, v) => s + v.total_calls, 0);
    if (totalAll > 0) {
      const share = top.total_calls / totalAll;
      if (share > 0.8) {
        out.push({
          tone: 'info',
          title: `${top.vendor_name} drove ${pct(share, 0)} of volume`,
          detail: `Concentration risk if this vendor goes down. Consider distributing more volume to alternatives.`,
        });
      }
    }
  }

  // 5. Volume trend (compare last 3 buckets vs first 3)
  if (series && series.length >= 6) {
    const firstHalf = series.slice(0, 3).reduce((s, b) => s + b.total, 0);
    const lastHalf = series.slice(-3).reduce((s, b) => s + b.total, 0);
    if (firstHalf > 0) {
      const change = (lastHalf - firstHalf) / firstHalf;
      if (Math.abs(change) > 0.25) {
        out.push({
          tone: change > 0 ? 'positive' : 'warning',
          title: `Volume trending ${change > 0 ? 'up' : 'down'} ${pct(Math.abs(change), 0)}`,
          detail: `Recent ${intf(lastHalf)} calls vs earlier ${intf(firstHalf)} in this window.`,
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Vendor analysis
// ---------------------------------------------------------------------------
export function vendorInsights(vcomp: VendorRow[] | undefined, cbreak: CampaignRow[] | undefined): Insight[] {
  if (!vcomp || !vcomp.length) return [];
  const out: Insight[] = [];

  // Active vs underused vendors
  const active = vcomp.filter(v => v.total_calls >= 50);
  const underused = vcomp.filter(v => v.total_calls > 0 && v.total_calls < 50);
  if (underused.length > 0) {
    out.push({
      tone: 'info',
      title: `${underused.length} vendor${underused.length > 1 ? 's' : ''} below comparison threshold`,
      detail: `${underused.map(v => v.vendor_name).join(', ')} ran fewer than 50 calls — too small a sample for fair comparison.`,
    });
  }

  if (active.length >= 2) {
    // Best vendor by interest rate
    const byInterest = [...active].sort((a, b) => b.interest_rate - a.interest_rate);
    const best = byInterest[0];
    const worst = byInterest[byInterest.length - 1];
    const gap = best.interest_rate - worst.interest_rate;
    if (gap > 0.05) {
      out.push({
        tone: 'positive',
        title: `${best.vendor_name} leads on interest rate`,
        detail: `${pct(best.interest_rate)} vs ${worst.vendor_name}'s ${pct(worst.interest_rate)} — a ${pct(gap)} gap on ${intf(best.total_calls)}+ calls.`,
      });
    }

    // Best on connection rate
    const byConn = [...active].sort((a, b) => b.connection_rate - a.connection_rate);
    if (byConn[0].vendor_name !== best.vendor_name) {
      out.push({
        tone: 'neutral',
        title: `Different leaders on connection vs interest`,
        detail: `${byConn[0].vendor_name} connects more (${pct(byConn[0].connection_rate)}) but ${best.vendor_name} converts better. Volume vs quality trade-off.`,
      });
    }
  }

  // Campaign breakdown insights
  if (cbreak && cbreak.length >= 3) {
    const sorted = [...cbreak].sort((a, b) => b.interest_rate - a.interest_rate);
    const topCamp = sorted[0];
    if (topCamp.connected_calls >= 20) {
      out.push({
        tone: 'positive',
        title: `Top campaign: ${pct(topCamp.interest_rate)} interest rate`,
        detail: `${topCamp.display_name || topCamp.campaign_name} — ${intf(topCamp.connected_calls)} connected, ${intf(topCamp.interested_calls)} interested.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Agent performance
// ---------------------------------------------------------------------------
export function agentInsights(perf: AgentPerformanceRow[] | undefined): Insight[] {
  if (!perf || !perf.length) return [];
  const out: Insight[] = [];

  const active = perf.filter(a => a.connected_calls >= 30);
  if (!active.length) {
    out.push({
      tone: 'info',
      title: 'Not enough data for agent comparison yet',
      detail: 'No agent has 30+ connected calls in this window. Comparisons would be noisy.',
    });
    return out;
  }

  // Top agent by interest rate
  const byInterest = [...active].sort((a, b) => b.interest_rate - a.interest_rate);
  const top = byInterest[0];
  out.push({
    tone: 'positive',
    title: `Top performer: ${top.agent_name}`,
    detail: `${pct(top.interest_rate)} interest rate over ${intf(top.connected_calls)} connected calls. Voice: ${top.voice_persona || '—'}, Lang: ${top.language || '—'}.`,
  });

  // Connection-vs-interest gap (open well but don't close)
  const gappers = active
    .filter(a => a.connection_rate >= 0.4 && a.interest_rate < 0.15)
    .sort((a, b) => b.total_calls - a.total_calls);
  if (gappers.length) {
    const a = gappers[0];
    out.push({
      tone: 'warning',
      title: `${a.agent_name} opens well but doesn't convert`,
      detail: `Connects at ${pct(a.connection_rate)} but only ${pct(a.interest_rate)} interested. The script gets people on the call — the pitch needs work.`,
    });
  }

  // Volume concentration
  const totalCalls = active.reduce((s, a) => s + a.total_calls, 0);
  if (totalCalls > 0) {
    const topShare = top.total_calls / totalCalls;
    if (topShare > 0.7) {
      out.push({
        tone: 'info',
        title: `${top.agent_name} carries ${pct(topShare, 0)} of volume`,
        detail: `Most calls ride on a single agent. Test alternates to reduce risk and find better-converting scripts.`,
      });
    }
  }

  // Language pattern
  const byLang = new Map<string, { calls: number; interested: number }>();
  for (const a of active) {
    const lang = a.language || 'Unknown';
    const cur = byLang.get(lang) || { calls: 0, interested: 0 };
    cur.calls += a.connected_calls;
    cur.interested += Math.round(a.connected_calls * a.interest_rate);
    byLang.set(lang, cur);
  }
  if (byLang.size >= 2) {
    const ranked = [...byLang.entries()]
      .map(([lang, d]) => ({ lang, rate: d.calls > 0 ? d.interested / d.calls : 0, calls: d.calls }))
      .filter(x => x.calls >= 30)
      .sort((a, b) => b.rate - a.rate);
    if (ranked.length >= 2 && ranked[0].rate - ranked[ranked.length - 1].rate > 0.05) {
      out.push({
        tone: 'neutral',
        title: `${ranked[0].lang} converts better than ${ranked[ranked.length - 1].lang}`,
        detail: `${pct(ranked[0].rate)} vs ${pct(ranked[ranked.length - 1].rate)} interest rate.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Call logs (page-level)
// ---------------------------------------------------------------------------
export function callsInsights(page: CallListPage | undefined): Insight[] {
  if (!page || !page.items.length) return [];
  const out: Insight[] = [];
  const items = page.items;

  // Pickup distribution
  const pickup = { HUMAN: 0, MACHINE: 0, UNKNOWN: 0 } as Record<string, number>;
  for (const c of items) pickup[c.answered_by] = (pickup[c.answered_by] || 0) + 1;
  const total = items.length;
  if (total > 0 && pickup.MACHINE > 0) {
    const machineShare = pickup.MACHINE / total;
    if (machineShare > 0.15) {
      out.push({
        tone: 'warning',
        title: `${pct(machineShare, 0)} of pickups are voicemail/machines`,
        detail: `${pickup.MACHINE} of ${total} on this page hit a machine. Adjust dial windows or skip-trace bad numbers.`,
      });
    }
  }

  // Recording coverage
  const completed = items.filter(c => c.lifecycle_status === 'COMPLETED');
  if (completed.length >= 5) {
    const withRec = completed.filter(c => c.has_recording).length;
    const cov = withRec / completed.length;
    if (cov < 0.7) {
      out.push({
        tone: 'warning',
        title: `Only ${pct(cov, 0)} of completed calls have recordings`,
        detail: `${withRec} of ${completed.length} completed calls on this page are recorded. Missing recordings hurt QA.`,
      });
    } else if (cov >= 0.95) {
      out.push({
        tone: 'positive',
        title: `Recording coverage is strong (${pct(cov, 0)})`,
        detail: `${withRec} of ${completed.length} completed calls captured. Good for QA.`,
      });
    }
  }

  // Total dataset size
  if (page.total > 0) {
    out.push({
      tone: 'info',
      title: `${intf(page.total)} calls match these filters`,
      detail: page.total > 1000
        ? 'Large dataset — narrow with date or vendor for faster review.'
        : `Showing page ${page.page} of ${Math.ceil(page.total / page.page_size)}.`,
    });
  }

  return out;
}
