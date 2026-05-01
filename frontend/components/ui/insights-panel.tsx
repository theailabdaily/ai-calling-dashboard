'use client';
import { TrendingUp, AlertTriangle, Info, Lightbulb } from 'lucide-react';

export type InsightTone = 'positive' | 'neutral' | 'warning' | 'info';

export type Insight = {
  tone: InsightTone;
  title: string;
  detail?: string;
};

const TONE_STYLES: Record<InsightTone, { bg: string; text: string; iconColor: string; Icon: typeof Info }> = {
  positive: { bg: 'bg-emerald-50',  text: 'text-emerald-900',  iconColor: 'text-emerald-600', Icon: TrendingUp },
  neutral:  { bg: 'bg-surface-100', text: 'text-surface-800',  iconColor: 'text-surface-500', Icon: Lightbulb },
  warning:  { bg: 'bg-amber-50',    text: 'text-amber-900',    iconColor: 'text-amber-600',   Icon: AlertTriangle },
  info:     { bg: 'bg-sky-50',      text: 'text-sky-900',      iconColor: 'text-sky-600',     Icon: Info },
};

type Props = {
  insights: Insight[];
  title?: string;
  subtitle?: string;
};

export default function InsightsPanel({ insights, title = 'What the numbers say', subtitle }: Props) {
  if (!insights.length) return null;
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-brand-navy flex items-center gap-1.5">
            <Lightbulb size={14} className="text-brand-pink" />
            {title}
          </h3>
          {subtitle && <p className="text-xs text-surface-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-2">
        {insights.map((ins, i) => {
          const s = TONE_STYLES[ins.tone];
          return (
            <div key={i} className={`${s.bg} rounded-lg px-3 py-2.5 flex items-start gap-2.5`}>
              <s.Icon size={14} className={`${s.iconColor} mt-0.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${s.text}`}>{ins.title}</div>
                {ins.detail && <div className={`text-xs mt-0.5 opacity-80 ${s.text}`}>{ins.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
