'use client';
import type { FunnelStage } from '@/types';
import { fmt } from '@/lib/api';

export type FunnelStageKey = 'total' | 'connected' | 'engaged' | 'interested' | 'followup';

// Map display label → backend stage key. Order matches the funnel.
const STAGE_KEYS: FunnelStageKey[] = ['total', 'connected', 'engaged', 'interested', 'followup'];

type Props = {
  data: FunnelStage[];
  onStageClick?: (stage: FunnelStageKey, label: string, count: number) => void;
};

export default function FunnelChart({ data, onStageClick }: Props) {
  const max = Math.max(...data.map(d => d.count), 1);
  const top = data[0]?.count || 1;

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-brand-navy">Conversion funnel</h3>
        {onStageClick && (
          <span className="text-[11px] text-surface-500">Click any stage to view leads</span>
        )}
      </div>
      <p className="text-xs text-surface-500 mb-4">From dialed to follow-up</p>
      <div className="space-y-2">
        {data.map((stage, i) => {
          const pct = (stage.count / max) * 100;
          const dropOff = top > 0 ? (stage.count / top) * 100 : 0;
          const stageKey = STAGE_KEYS[i] || 'total';
          const isClickable = !!onStageClick && stage.count > 0;
          return (
            <button
              key={stage.stage}
              onClick={isClickable ? () => onStageClick!(stageKey, stage.stage, stage.count) : undefined}
              disabled={!isClickable}
              className={
                'w-full text-left ' +
                (isClickable ? 'cursor-pointer hover:bg-surface-50 -mx-2 px-2 py-1 rounded-md transition-colors' : 'cursor-default')
              }
            >
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-sm font-medium text-surface-700 flex items-center gap-1.5">
                  {stage.stage}
                  {isClickable && (
                    <span className="text-[10px] text-brand-pink uppercase tracking-wider opacity-0 group-hover:opacity-100">→</span>
                  )}
                </span>
                <span className="text-sm tabular-nums">
                  <span className="font-semibold text-brand-navy">{fmt.int(stage.count)}</span>
                  <span className="text-surface-500 ml-2 text-xs">{dropOff.toFixed(1)}% of top</span>
                </span>
              </div>
              <div className="h-9 bg-surface-100 rounded-md overflow-hidden">
                <div
                  className="h-full rounded-md transition-all duration-500"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, #1B1A36 0%, #E8345C ${100 - i * 15}%)`,
                  }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
