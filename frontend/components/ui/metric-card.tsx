import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/api';

type Props = {
  label: string;
  value: string | number;
  hint?: string;
  trend?: 'up' | 'down' | 'flat';
  accent?: boolean;
  /** When set, the card becomes a clickable link to this URL. */
  href?: string;
};

export default function MetricCard({ label, value, hint, accent, href }: Props) {
  const inner = (
    <>
      <div className="flex items-start justify-between">
        <div className="text-xs font-medium uppercase tracking-wider text-surface-500">{label}</div>
        {href && <ArrowUpRight size={14} className="text-surface-400 group-hover:text-brand-pink transition-colors" />}
      </div>
      <div className="mt-2 text-3xl font-semibold text-brand-navy tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-surface-500">{hint}</div>}
    </>
  );

  const baseCls = cn(
    'card p-5 block',
    accent && 'border-brand-pink/30 bg-gradient-to-br from-white to-brand-pink/5',
    href && 'group cursor-pointer hover:border-brand-pink/40 hover:shadow-md transition-all'
  );

  if (href) {
    return <Link href={href} className={baseCls}>{inner}</Link>;
  }
  return <div className={baseCls}>{inner}</div>;
}
