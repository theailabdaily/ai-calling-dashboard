import Link from 'next/link';
import { ArrowUpRight, Info } from 'lucide-react';
import { cn } from '@/lib/api';

type Props = {
  label: string;
  value: string | number;
  hint?: string;
  trend?: 'up' | 'down' | 'flat';
  accent?: boolean;
  /** When set, the card becomes a clickable link to this URL. */
  href?: string;
  /** Tooltip text shown on hover over the (i) icon. */
  tooltip?: string;
};

export default function MetricCard({ label, value, hint, accent, href, tooltip }: Props) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-surface-500 truncate">{label}</div>
          {tooltip && (
            <span className="relative inline-flex items-center group/tip shrink-0">
              <Info size={12} className="text-surface-400 hover:text-surface-600 cursor-help" />
              <span
                className="invisible group-hover/tip:visible opacity-0 group-hover/tip:opacity-100 transition-opacity absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 w-64 px-3 py-2 rounded-lg bg-brand-navy text-white text-[11px] leading-snug normal-case tracking-normal font-normal shadow-lg pointer-events-none"
                role="tooltip"
              >
                {tooltip}
              </span>
            </span>
          )}
        </div>
        {href && <ArrowUpRight size={14} className="text-surface-400 group-hover:text-brand-pink transition-colors shrink-0" />}
      </div>
      <div className="mt-1.5 md:mt-2 text-2xl md:text-3xl font-semibold text-brand-navy tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-surface-500">{hint}</div>}
    </>
  );

  const baseCls = cn(
    'card p-4 md:p-5 block',
    accent && 'border-brand-pink/30 bg-gradient-to-br from-white to-brand-pink/5',
    href && 'group cursor-pointer hover:border-brand-pink/40 hover:shadow-md transition-all'
  );

  if (href) {
    return <Link href={href} className={baseCls}>{inner}</Link>;
  }
  return <div className={baseCls}>{inner}</div>;
}
