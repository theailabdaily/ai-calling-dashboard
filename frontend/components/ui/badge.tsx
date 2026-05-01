import { cn } from '@/lib/api';

type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

const TONES: Record<Tone, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  danger:  'bg-rose-100 text-rose-700',
  neutral: 'bg-surface-200 text-surface-700',
  info:    'bg-brand-pink/10 text-brand-pink',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = toneFor(status);
  return (
    <span className={cn('pill', TONES[tone])}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={cn('pill', TONES[tone])}>{children}</span>;
}

function toneFor(status: string): Tone {
  const s = status.toUpperCase();
  if (s === 'COMPLETED' || s === 'ENGAGED' || s === 'HUMAN') return 'success';
  if (s === 'IN_PROGRESS' || s === 'RINGING' || s === 'INITIATED' || s === 'SCHEDULED') return 'info';
  if (s === 'FAILED' || s === 'CANCELLED' || s === 'NOT_CONNECTED') return 'danger';
  if (s === 'MACHINE' || s === 'NOT_ENGAGED') return 'warning';
  return 'neutral';
}
