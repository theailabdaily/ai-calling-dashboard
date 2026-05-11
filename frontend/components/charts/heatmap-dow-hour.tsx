'use client';
import { useState, useMemo } from 'react';
import { Calendar } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { HeatmapCell } from '@/types';

type Metric = 'volume' | 'connection' | 'interest' | 'callback';

type Props = { data: HeatmapCell[] };

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 7];
const DOW_LABEL: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  if (h < 12) return `${h}a`;
  return `${h - 12}p`;
}

// Pink scale (brand) — 0 = empty surface, 1 = full brand-pink
function colorFor(value: number, hasData: boolean): string {
  if (!hasData) return '#F1F2F6';            // empty cell
  if (value <= 0) return '#FCE7EC';
  // Interpolate brand-pink (#E8345C) at varying alpha
  const alpha = Math.max(0.12, Math.min(1, value));
  return `rgba(232, 52, 92, ${alpha.toFixed(2)})`;
}

function metricValue(c: HeatmapCell, m: Metric, maxVol: number): number {
  if (m === 'volume') return maxVol > 0 ? c.total_calls / maxVol : 0;
  if (m === 'connection') return c.connection_rate;
  if (m === 'callback') return c.callback_rate ?? 0;
  return c.interest_rate;
}

export default function HeatmapDowHour({ data }: Props) {
  const [metric, setMetric] = useState<Metric>('connection');

  const { cellByKey, maxVol, totalCalls } = useMemo(() => {
    const map = new Map<string, HeatmapCell>();
    let mv = 0;
    let total = 0;
    for (const c of data) {
      map.set(`${c.dow}-${c.hour}`, c);
      if (c.total_calls > mv) mv = c.total_calls;
      total += c.total_calls;
    }
    return { cellByKey: map, maxVol: mv, totalCalls: total };
  }, [data]);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
          <Calendar size={14} className="text-brand-pink" />
          Day × Hour heatmap (IST)
        </h3>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-surface-500 mr-1">Color by:</span>
          {(['volume', 'connection', 'interest', 'callback'] as Metric[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                metric === m
                  ? 'bg-brand-pink text-white'
                  : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
              }`}
            >
              {m === 'volume'
                ? 'Volume'
                : m === 'connection'
                ? 'Connection %'
                : m === 'interest'
                ? 'Interest %'
                : 'Callback %'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-surface-500 mb-4">
        Each cell is one weekday × hour combination. Empty cells = never tested. Hover any cell for full metrics.
      </p>

      {totalCalls === 0 ? (
        <div className="text-xs text-surface-500 py-12 text-center">No call data in this window.</div>
      ) : (
        <div className="overflow-x-auto">
          {/* Hour header row */}
          <div className="inline-block min-w-full">
            <div className="flex items-center text-[10px] text-surface-500 font-mono mb-1">
              <div className="w-10 shrink-0" /> {/* corner spacer */}
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="w-7 shrink-0 text-center">{hourLabel(h)}</div>
              ))}
            </div>

            {DOW_ORDER.map(dow => (
              <div key={dow} className="flex items-center mb-0.5">
                <div className="w-10 shrink-0 text-[11px] text-surface-600 font-medium">
                  {DOW_LABEL[dow]}
                </div>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = cellByKey.get(`${dow}-${h}`);
                  const has = !!c && c.total_calls > 0;
                  const v = c ? metricValue(c, metric, maxVol) : 0;
                  const bg = colorFor(v, has);
                  const tip = c
                    ? `${DOW_LABEL[dow]} ${hourLabel(h)}\n` +
                      `${fmt.int(c.total_calls)} calls, ${fmt.int(c.connected_calls)} connected\n` +
                      `Connection: ${fmt.pct(c.connection_rate)}\n` +
                      `Interest: ${fmt.pct(c.interest_rate)}\n` +
                      `Callback: ${fmt.pct(c.callback_rate ?? 0)}\n` +
                      `Avg duration: ${fmt.duration(c.avg_duration_seconds)}`
                    : `${DOW_LABEL[dow]} ${hourLabel(h)} — never tested`;
                  return (
                    <div
                      key={h}
                      title={tip}
                      className="w-7 h-7 shrink-0 border border-white"
                      style={{ backgroundColor: bg }}
                    >
                      {has && c!.total_calls >= 30 && metric === 'volume' && (
                        <div className="text-[9px] text-white text-center leading-7 font-semibold mix-blend-difference">
                          {c!.total_calls > 99 ? '99+' : c!.total_calls}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 mt-4 text-[11px] text-surface-500">
            <span>Low</span>
            <div className="flex">
              {[0.15, 0.3, 0.5, 0.7, 1.0].map(a => (
                <div
                  key={a}
                  className="w-6 h-3 border border-white"
                  style={{ backgroundColor: `rgba(232, 52, 92, ${a})` }}
                />
              ))}
            </div>
            <span>High</span>
            <div className="flex items-center gap-1 ml-3">
              <div className="w-3 h-3 border border-white" style={{ backgroundColor: '#F1F2F6' }} />
              <span>= never tested</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
