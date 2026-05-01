import { cn } from '@/lib/api';

type Props = {
  label: string;
  value: string | number;
  hint?: string;
  trend?: 'up' | 'down' | 'flat';
  accent?: boolean;
};

export default function MetricCard({ label, value, hint, accent }: Props) {
  return (
    <div className={cn('card p-5', accent && 'border-brand-pink/30 bg-gradient-to-br from-white to-brand-pink/5')}>
      <div className="text-xs font-medium uppercase tracking-wider text-surface-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-brand-navy tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-surface-500">{hint}</div>}
    </div>
  );
}
