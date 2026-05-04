'use client';
import { Copy, Info } from 'lucide-react';
import type { DuplicateCampaign } from '@/types';
import { fmt } from '@/lib/api';

type Props = {
  count: number;                       // duplicate_leads
  rows: number;                        // duplicate_rows
  dialAttempts: number;                // duplicate_dial_attempts
  campaigns: DuplicateCampaign[];
};

// Estimate of dial attempts that wouldn't exist if duplicates had been
// deduped before upload. Not a strict "waste" claim — re-targeting can be
// intentional — but a useful upper bound for the conversation.
//
// Logic: if N leads got dialed in K campaigns each (where K > 1) and the
// total dial attempts on those leads is D, then deduplicating to one
// campaign would have produced ~D/K dials. Extra = D − D/K = D × (K−1)/K.
// We approximate K with rows/leads (avg campaigns-per-dup-lead).
function estimateExtraDials(rows: number, leads: number, dials: number): number {
  if (leads <= 0 || rows <= leads) return 0;
  const avgK = rows / leads;            // typically ~2
  return Math.round(dials * (avgK - 1) / avgK);
}

export default function DuplicateLeadsCard({ count, rows, dialAttempts, campaigns }: Props) {
  // Hide entirely when there are no duplicates — no point surfacing a zero
  // and burning visual real estate.
  if (count <= 0) return null;

  const extraDials = estimateExtraDials(rows, count, dialAttempts);
  const avgKDisplay = (rows / count).toFixed(1);

  return (
    <div className="card p-5 border-amber-200 bg-amber-50/40">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
          <Copy size={14} className="text-amber-600" />
          Cross-campaign duplicates · {fmt.int(count)}
        </h3>
        <span className="text-[11px] text-amber-700/70">accidental re-uploads?</span>
      </div>
      <p className="text-xs text-surface-600 mb-3">
        Phones dialed in <strong>{avgKDisplay}</strong> campaigns on average. Same
        person, multiple uploads — usually a re-upload of an old lead list. Consumes
        extra dials without expanding reach.
      </p>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Duplicate leads"
          value={fmt.int(count)}
          hint={`across ${fmt.int(rows)} rows`}
        />
        <Stat
          label="Dials spent on dupes"
          value={fmt.int(dialAttempts)}
          hint="initial + retries"
        />
        <Stat
          label="≈ Avoidable dials"
          value={fmt.int(extraDials)}
          hint="if deduped pre-upload"
          tip="Estimate — assumes deduping would have left only one campaign's worth of dials per lead. Re-targeting may be intentional, in which case this is not waste."
        />
      </div>

      {/* Per-campaign detail — show which campaigns share the phones. Useful
          for the operator to identify the bad upload and prevent future ones. */}
      {campaigns.length > 0 && (
        <div className="mt-4 pt-3 border-t border-amber-200/70">
          <div className="text-[11px] font-medium uppercase tracking-wider text-surface-500 mb-2">
            Campaigns sharing these leads
          </div>
          <div className="space-y-1.5">
            {campaigns.map(c => (
              <div
                key={c.campaign_id}
                className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-md bg-white/60 hover:bg-white transition-colors"
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[12px] font-medium text-surface-800 truncate">
                    {c.campaign_name}
                  </span>
                  {c.started_at && (
                    <span className="text-[10px] text-surface-500 shrink-0">
                      {c.started_at.slice(0, 10)}
                    </span>
                  )}
                </div>
                <div className="text-[11px] tabular-nums shrink-0">
                  <span className="font-semibold text-brand-navy">{fmt.int(c.shared_leads)}</span>
                  <span className="text-surface-500 ml-1">shared</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tip }: { label: string; value: string; hint?: string; tip?: string }) {
  return (
    <div className="rounded-md bg-white/60 border border-amber-100 p-2.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-surface-500">
        <span className="truncate">{label}</span>
        {tip && (
          <span className="relative inline-flex items-center group/tip">
            <Info size={10} className="text-surface-400 hover:text-surface-600 cursor-help shrink-0" />
            <span
              role="tooltip"
              className="invisible group-hover/tip:visible opacity-0 group-hover/tip:opacity-100 transition-opacity
                         absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-20 w-56 px-2 py-1.5 rounded-md
                         bg-brand-navy text-white text-[11px] leading-snug normal-case tracking-normal font-normal
                         shadow-lg pointer-events-none"
            >
              {tip}
            </span>
          </span>
        )}
      </div>
      <div className="mt-1 text-lg font-semibold text-brand-navy tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-surface-500">{hint}</div>}
    </div>
  );
}
