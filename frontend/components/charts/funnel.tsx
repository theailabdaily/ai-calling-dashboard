'use client';
import type { FunnelStage } from '@/types';
import { fmt } from '@/lib/api';

type Props = { data: FunnelStage[] };

export default function FunnelChart({ data }: Props) {
  const max = Math.max(...data.map(d => d.count), 1);
  const top = data[0]?.count || 1;

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-brand-navy mb-1">Conversion funnel</h3>
      <p className="text-xs text-surface-500 mb-4">From dialed to follow-up</p>
      <div className="space-y-2">
        {data.map((stage, i) => {
          const pct = (stage.count / max) * 100;
          const dropOff = top > 0 ? (stage.count / top) * 100 : 0;
          return (
            <div key={stage.stage}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-sm font-medium text-surface-700">{stage.stage}</span>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
