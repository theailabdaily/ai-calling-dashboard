'use client';
import { TrendingUp, TrendingDown, Clock, Sparkles } from 'lucide-react';
import { fmt } from '@/lib/api';
import type { HourBucket } from '@/types';

type Props = { data: HourBucket[] };

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

const MIN_N = 30;

export default function HourlyKpiStrip({ data }: Props) {
  if (!data.length) return null;

  const significant = data.filter(b => b.total_calls >= MIN_N);
  const peakVol = [...data].sort((a, b) => b.total_calls - a.total_calls)[0];
  const bestConn = significant.length
    ? [...significant].sort((a, b) => b.connection_rate - a.connection_rate)[0]
    : null;
  const bestInt = significant.length
    ? [...significant].sort((a, b) => b.interest_rate - a.interest_rate)[0]
    : null;
  const sweetSpot = bestConn && bestInt && bestConn.hour === bestInt.hour ? bestConn : null;

  const cards: Array<{
    label: string; value: string; hint?: string; icon: any; tone: 'pink' | 'green' | 'navy' | 'amber';
  }> = [];

  cards.push({
    label: 'Peak volume hour',
    value: hourLabel(peakVol.hour),
    hint: `${fmt.int(peakVol.total_calls)} calls`,
    icon: Clock,
    tone: 'navy',
  });

  if (bestConn) {
    cards.push({
      label: 'Best connection hour',
      value: hourLabel(bestConn.hour),
      hint: `${fmt.pct(bestConn.connection_rate)} on ${fmt.int(bestConn.total_calls)} calls`,
      icon: TrendingUp,
      tone: 'pink',
    });
  } else {
    cards.push({
      label: 'Best connection hour',
      value: '—',
      hint: `Need ≥${MIN_N} calls in an hour`,
      icon: TrendingUp,
      tone: 'navy',
    });
  }

  if (bestInt) {
    cards.push({
      label: 'Best interest hour',
      value: hourLabel(bestInt.hour),
      hint: `${fmt.pct(bestInt.interest_rate)} of connected`,
      icon: TrendingUp,
      tone: 'green',
    });
  } else {
    cards.push({
      label: 'Best interest hour',
      value: '—',
      hint: `Need ≥${MIN_N} calls in an hour`,
      icon: TrendingUp,
      tone: 'navy',
    });
  }

  if (sweetSpot) {
    cards.push({
      label: 'Sweet spot',
      value: hourLabel(sweetSpot.hour),
      hint: `Best for both pickup AND interest`,
      icon: Sparkles,
      tone: 'amber',
    });
  } else if (significant.length >= 2) {
    const worst = [...significant].sort((a, b) => a.connection_rate - b.connection_rate)[0];
    cards.push({
      label: 'Weakest hour',
      value: hourLabel(worst.hour),
      hint: `${fmt.pct(worst.connection_rate)} connection`,
      icon: TrendingDown,
      tone: 'navy',
    });
  } else {
    cards.push({
      label: 'Sweet spot',
      value: '—',
      hint: 'Need more variance to compare',
      icon: Sparkles,
      tone: 'navy',
    });
  }

  const toneStyles: Record<string, { bg: string; text: string; iconBg: string; iconColor: string }> = {
    pink:  { bg: 'bg-brand-pink/10',  text: 'text-brand-navy',   iconBg: 'bg-brand-pink/20',  iconColor: 'text-brand-pink' },
    green: { bg: 'bg-emerald-50',     text: 'text-emerald-900',  iconBg: 'bg-emerald-100',    iconColor: 'text-emerald-600' },
    amber: { bg: 'bg-amber-50',       text: 'text-amber-900',    iconBg: 'bg-amber-100',      iconColor: 'text-amber-600' },
    navy:  { bg: 'bg-surface-50',     text: 'text-brand-navy',   iconBg: 'bg-surface-100',    iconColor: 'text-surface-500' },
  };

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c, idx) => {
        const Icon = c.icon;
        const s = toneStyles[c.tone];
        return (
          <div key={idx} className={`card p-4 ${s.bg} border-0`}>
            <div className="flex items-start gap-3">
              <div className={`${s.iconBg} ${s.iconColor} p-2 rounded-lg shrink-0`}>
                <Icon size={16} />
              </div>
              <div className="min-w-0">
                <div className={`text-[11px] uppercase tracking-wide ${s.text} opacity-70 font-medium`}>
                  {c.label}
                </div>
                <div className={`text-xl font-semibold ${s.text} mt-0.5 leading-tight`}>{c.value}</div>
                {c.hint && (
                  <div className={`text-[11px] ${s.text} opacity-75 mt-0.5 leading-tight`}>
                    {c.hint}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
