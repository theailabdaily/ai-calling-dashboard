'use client';
import Link from 'next/link';
import { ExternalLink, Info, ArrowRight, Database, Activity } from 'lucide-react';

// This dashboard is now READ-ONLY for campaign creation.
// Campaigns are created directly in each vendor's UI (Hunar, SquadStack, etc.).
// We sync the resulting calls automatically — no push from this side.
//
// The CSV-upload + Google-Sheet flows that used to live on this page have been
// retired (their backend endpoints now return 410). Rationale:
//   1. Vendor UIs surface API submissions in a different bucket than UI-created
//      campaigns, making analytics ambiguous.
//   2. Each vendor's prompt/persona/script editor is richer than what we'd
//      replicate here; better to use it directly.
//   3. Read-only mirror = single source of truth = no double-dial risk.

export default function LaunchCampaignPage() {
  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4 md:space-y-5">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy">Launch campaign</h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Campaigns are managed in your vendor's dashboard. This view is now read-only.
        </p>
      </header>

      <div className="card border-brand-pink/30 bg-gradient-to-br from-white to-brand-pink/5 p-4 md:p-6">
        <div className="flex gap-3">
          <Info size={20} className="text-brand-pink shrink-0 mt-0.5" />
          <div className="space-y-3 flex-1">
            <h2 className="text-base font-semibold text-brand-navy">
              Where to launch a new campaign
            </h2>
            <p className="text-sm text-surface-700 leading-relaxed">
              Create campaigns directly in your vendor's dashboard — that's where the
              prompt editor, voice persona controls, and call-list mapping live.
              Calls dialed there will sync to this dashboard automatically within
              ~15 minutes.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              <a
                href="https://voice.hunar.ai/campaigns"
                target="_blank"
                rel="noreferrer"
                className="card p-4 hover:border-brand-pink/40 hover:shadow-md transition-all flex items-start gap-3 group"
              >
                <div className="w-10 h-10 rounded-lg bg-brand-navy/5 flex items-center justify-center shrink-0">
                  <Activity size={18} className="text-brand-navy" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-brand-navy flex items-center gap-1">
                    Hunar
                    <ExternalLink size={12} className="text-surface-400 group-hover:text-brand-pink transition-colors" />
                  </div>
                  <div className="text-xs text-surface-500 mt-0.5">
                    voice.hunar.ai/campaigns
                  </div>
                </div>
              </a>

              <div className="card p-4 flex items-start gap-3 opacity-60">
                <div className="w-10 h-10 rounded-lg bg-surface-100 flex items-center justify-center shrink-0">
                  <Activity size={18} className="text-surface-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-surface-700">SquadStack</div>
                  <div className="text-xs text-surface-500 mt-0.5">
                    Coming soon — stub adapter only
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4 md:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-surface-500" />
          <h3 className="text-sm font-semibold text-brand-navy">How sync works</h3>
        </div>
        <ol className="space-y-2 text-sm text-surface-700 list-none pl-0">
          <Step n={1}>You create a campaign in the vendor's UI and start dialing.</Step>
          <Step n={2}>Hunar sends webhooks to this app as each call progresses.</Step>
          <Step n={3}>A 15-minute cron also pulls anything missed by webhooks (catch-up).</Step>
          <Step n={4}>Numbers, durations, outcomes, and recordings appear here automatically.</Step>
        </ol>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 pt-2">
        <Link href="/" className="btn bg-brand-pink text-white hover:bg-brand-pink/90">
          Back to overview <ArrowRight size={14} />
        </Link>
        <Link href="/calls" className="btn-outline">
          See latest calls
        </Link>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-5 h-5 rounded-full bg-brand-pink/10 text-brand-pink text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
