'use client';
import { Info } from 'lucide-react';
import type { FunnelStage } from '@/types';
import { fmt } from '@/lib/api';

// Stable keys used by the click-through drill-down. Must stay in sync with
// the `key` field returned by /api/overview/funnel and the funnel_stage
// query param accepted by /api/calls and /api/export/calls.csv.
export type FunnelStageKey =
  | 'leads'
  | 'connected'
  | 'engaged'
  | 'interested'
  | 'callback'
  | 'top_priority'
  | 'callback_only'
  // Legacy — kept so old bookmarks don't 404
  | 'hotleads'
  | 'followup';

type Props = {
  data: FunnelStage[];
  // Optional: dial-attempts for this window. Shown as a subheader so the
  // funnel itself stays purely lead-level (avoids the unit-mixing bug
  // where Total Dials = 3050 made Connected = 250 look like 8% conversion
  // when the real lead-level rate is 41%).
  totalDials?: number | null;
  onStageClick?: (stage: FunnelStageKey, label: string, count: number) => void;
};

export default function FunnelChart({ data, totalDials, onStageClick }: Props) {
  const top = data[0]?.count || 1;
  // We scale bar widths against the top stage so the funnel always starts at
  // 100%. If a downstream stage somehow exceeds the top (shouldn't with
  // current definitions, but defensive), it'll clip to 100% visually but
  // the number remains accurate.
  const max = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-brand-navy">Conversion funnel</h3>
        {onStageClick && (
          <span className="text-[11px] text-surface-500">Click any stage to view leads</span>
        )}
      </div>
      <p className="text-xs text-surface-500 mb-1">
        Unique-lead basis. Each stage counts distinct phone numbers, not dial attempts.
        Drop-off shown vs. each stage's parent — see the (i) on each stage for definition.
      </p>
      {totalDials != null && totalDials > 0 && top > 0 && (
        <p className="text-[11px] text-surface-400 mb-4 tabular-nums">
          Across {fmt.int(totalDials)} dial attempts ({(totalDials / top).toFixed(2)} per lead — retries included)
        </p>
      )}
      {(totalDials == null || totalDials === 0) && <div className="mb-4" />}

      <div className="space-y-3">
        {data.map((stage) => {
          const pct = (stage.count / max) * 100;
          const stageKey = (stage.key as FunnelStageKey) || 'leads';
          const isClickable = !!onStageClick && stage.count > 0;

          // Drop-off from previous stage — the conversion rate that matters
          // for diagnosing where leads die. `null` for the top stage.
          const fromPrev = stage.rate_of_previous;
          const fromTop = stage.rate_of_top;

          return (
            <button
              key={stage.stage}
              onClick={isClickable ? () => onStageClick!(stageKey, stage.stage, stage.count) : undefined}
              disabled={!isClickable}
              className={
                'w-full text-left group ' +
                (isClickable
                  ? 'cursor-pointer hover:bg-surface-50 -mx-2 px-2 py-1 rounded-md transition-colors'
                  : 'cursor-default')
              }
            >
              <div className="flex items-baseline justify-between mb-1 gap-3">
                <span className="text-sm font-medium text-surface-700 flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{stage.stage}</span>
                  {/* Definition tooltip — surface the SQL-truth so users
                      know what's actually being counted. Hover (desktop) or
                      tap (mobile via title attribute fallback). */}
                  {stage.definition && (
                    <span
                      className="relative inline-flex"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Info
                        size={12}
                        className="text-surface-400 hover:text-brand-pink transition-colors"
                      />
                      <span
                        className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-5 z-10
                                   w-64 p-2 rounded-md bg-brand-navy text-white text-[11px] leading-snug
                                   opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                      >
                        {stage.definition}
                      </span>
                    </span>
                  )}
                  {isClickable && (
                    <span className="text-[10px] text-brand-pink uppercase tracking-wider">→</span>
                  )}
                </span>
                <span className="text-sm tabular-nums whitespace-nowrap">
                  <span className="font-semibold text-brand-navy">{fmt.int(stage.count)}</span>
                  {fromPrev != null ? (
                    <span className="text-surface-500 ml-2 text-xs">
                      {(fromPrev * 100).toFixed(1)}% conv.
                    </span>
                  ) : (
                    <span className="text-surface-400 ml-2 text-xs">100%</span>
                  )}
                </span>
              </div>
              <div className="h-9 bg-surface-100 rounded-md overflow-hidden">
                <div
                  className="h-full rounded-md transition-all duration-500"
                  style={{
                    width: `${Math.min(pct, 100)}%`,
                    background: `linear-gradient(90deg, #1B1A36 0%, #E8345C 100%)`,
                    opacity: 0.5 + 0.5 * (stage.count / top),
                  }}
                />
              </div>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-[10px] text-surface-400 tabular-nums">
                  {(fromTop * 100).toFixed(1)}% of top
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
