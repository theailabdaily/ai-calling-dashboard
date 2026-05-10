'use client';
import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Search, Phone, PlayCircle, PauseCircle, AlertCircle, CheckCircle2,
  Clock, User, MessageSquare, Calendar, X,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { LookupResult, LookupCall } from '@/types';

// Stand-alone tool. No sidebar, no shared chrome, no vendor names anywhere
// in the UI or in the API responses. Looks intentionally different from
// the main analytics dashboard so a BDA can tell at a glance "this is the
// lookup tool" and not the broader analytics product.

export default function LookupPage() {
  const [phone, setPhone] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useMutation<LookupResult, Error, string>({
    mutationFn: (p: string) => api.lookup(p),
  });

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!phone.trim()) return;
    search.mutate(phone.trim());
  };

  const clear = () => {
    setPhone('');
    search.reset();
    inputRef.current?.focus();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header — distinct from main dashboard so BDAs know this is a different tool */}
      <header className="bg-brand-navy text-white">
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-4 md:py-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-pink/20 flex items-center justify-center shrink-0">
            <Search size={18} />
          </div>
          <div>
            <h1 className="text-lg md:text-xl font-semibold">Lead Lookup</h1>
            <p className="text-xs text-white/60">Paste a phone number to see call history and recordings.</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 md:px-6 py-5 md:py-8 space-y-4 md:space-y-5">
        {/* Search bar */}
        <form onSubmit={submit} className="card p-3 md:p-4">
          <label className="text-xs font-medium text-surface-700 mb-1.5 block">Phone number</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
              <input
                ref={inputRef}
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="9876543210 or +91 98765 43210"
                className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-surface-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
                autoFocus
              />
              {phone && (
                <button
                  type="button"
                  onClick={clear}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-surface-400 hover:text-surface-700 hover:bg-surface-100"
                  aria-label="Clear"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={!phone.trim() || search.isPending}
              className="btn bg-brand-pink text-white hover:bg-[#d92853] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {search.isPending ? 'Searching…' : 'Search'}
            </button>
          </div>
          <p className="text-xs text-surface-500 mt-2">
            Any format works — with or without +91, spaces, or dashes.
          </p>
        </form>

        {/* Error state */}
        {search.isError && (
          <div className="card p-4 border-red-200 bg-red-50 flex items-start gap-2">
            <AlertCircle size={16} className="text-red-600 mt-0.5 shrink-0" />
            <div className="text-sm text-red-900">
              {search.error instanceof Error ? search.error.message : 'Lookup failed. Try again.'}
            </div>
          </div>
        )}

        {/* Results */}
        {search.data && <ResultsView data={search.data} />}

        {/* Footer hint when nothing has been searched yet */}
        {!search.data && !search.isPending && !search.isError && (
          <div className="card p-8 text-center">
            <Search size={28} className="text-surface-300 mx-auto mb-2" />
            <p className="text-sm text-surface-600 font-medium">Enter a phone number to start</p>
            <p className="text-xs text-surface-500 mt-1">
              Lookup shows every call we have on this number, with outcomes and recordings.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------- Results view ----------
function ResultsView({ data }: { data: LookupResult }) {
  // Bad input — couldn't normalize
  if (!data.normalized_phone) {
    return (
      <div className="card p-4 border-amber-200 bg-amber-50 flex items-start gap-2">
        <AlertCircle size={16} className="text-amber-700 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-900">
          That doesn't look like a valid Indian mobile number. Try again with a 10-digit number.
        </div>
      </div>
    );
  }

  // Valid number, but no calls in our system
  if (!data.found || !data.summary) {
    return (
      <div className="card p-6 text-center">
        <div className="text-sm text-surface-700">
          No calls found for <span className="font-mono font-semibold">{data.normalized_phone}</span>
        </div>
        <p className="text-xs text-surface-500 mt-1.5">
          This number hasn't been dialed yet, or hasn't synced into the system.
        </p>
      </div>
    );
  }

  const { summary, calls, normalized_phone } = data;

  return (
    <>
      {/* Summary card */}
      <div className="card p-4 md:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-base md:text-lg font-semibold text-brand-navy truncate">
              {summary.callee_name || 'Unknown name'}
            </h2>
            <div className="text-sm text-surface-600 font-mono">{normalized_phone}</div>
          </div>
          {summary.latest_interest && (
            <span className={`pill border ${interestTone(summary.latest_interest)}`}>
              {summary.latest_interest}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 md:gap-3 pt-1">
          <Stat icon={<Phone size={14} />} label="Total calls" value={summary.total_calls.toString()} />
          <Stat icon={<Clock size={14} />} label="Total attempts" value={summary.total_attempts.toString()} />
          <Stat icon={<CheckCircle2 size={14} />} label="Picked up" value={summary.connected_count.toString()} />
          <Stat icon={<Clock size={14} />} label="Longest call" value={fmtDuration(summary.longest_duration_seconds)} />
        </div>

        {summary.narrative && (
          <div className="pt-1 border-t border-surface-100 mt-2">
            <div className="text-[10px] uppercase tracking-wider text-surface-500 mb-1">Summary</div>
            <p className="text-sm text-surface-800 leading-relaxed">{summary.narrative}</p>
          </div>
        )}
        {(summary.latest_objection || summary.latest_follow_up) && (
          <div className="pt-1 space-y-1.5 border-t border-surface-100 mt-2">
            {summary.latest_objection && (
              <div className="flex items-start gap-2 text-xs">
                <MessageSquare size={12} className="text-surface-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-surface-500">Latest objection: </span>
                  <span className="text-surface-800">{summary.latest_objection}</span>
                </div>
              </div>
            )}
            {summary.latest_follow_up && (
              <div className="flex items-start gap-2 text-xs">
                <Calendar size={12} className="text-surface-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-surface-500">Follow-up requested: </span>
                  <span className="text-surface-800">{summary.latest_follow_up}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="text-[11px] text-surface-500 pt-1 border-t border-surface-100">
          {summary.first_call_at && summary.last_call_at && (
            <>
              First contact: {format(new Date(summary.first_call_at), 'd MMM yyyy')} ·{' '}
              Last: {formatDistanceToNow(new Date(summary.last_call_at), { addSuffix: true })}
            </>
          )}
        </div>
      </div>

      {/* Per-call history */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-1">
          Call history ({calls.length})
        </div>
        {calls.map((c, idx) => (
          <CallRow key={c.id} call={c} index={calls.length - idx} />
        ))}
      </div>
    </>
  );
}

// ---------- Per-call row ----------
function CallRow({ call, index }: { call: LookupCall; index: number }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  const when = call.when ? new Date(call.when) : null;
  const tone = statusTone(call.status, call.answered_by);

  return (
    <div className="card p-3 md:p-4">
      <div className="flex items-start gap-3">
        <div className="text-xs font-mono tabular-nums text-surface-400 mt-0.5 shrink-0">#{index}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`pill border ${tone}`}>{statusLabel(call.status, call.answered_by)}</span>
              {call.duration_seconds > 0 && (
                <span className="text-xs text-surface-600 tabular-nums">
                  {fmtDuration(call.duration_seconds)}
                </span>
              )}
              {call.retry_count > 0 && (
                <span className="text-xs text-surface-500">retry #{call.retry_count}</span>
              )}
              {call.language && (
                <span className="text-xs text-surface-500">{call.language}</span>
              )}
            </div>
            {when && (
              <span className="text-xs text-surface-500" title={format(when, 'd MMM yyyy, HH:mm')}>
                {formatDistanceToNow(when, { addSuffix: true })}
              </span>
            )}
          </div>

          {call.summary && (
            <div className="mt-2 text-xs text-surface-700 leading-relaxed border-l-2 border-brand-pink/30 pl-2.5">
              {call.summary}
            </div>
          )}
          {(call.interest || call.objection_text || call.next_step || call.follow_up_at) && (
            <div className="mt-2 space-y-1 text-xs">
              {call.interest && (
                <div>
                  <span className="text-surface-500">Interest: </span>
                  <span className={`font-medium ${interestTextTone(call.interest)}`}>{call.interest}</span>
                </div>
              )}
              {call.objection_text && (
                <div className="text-surface-700">
                  <span className="text-surface-500">Said: </span>
                  &ldquo;{call.objection_text}&rdquo;
                </div>
              )}
              {call.next_step && call.next_step !== call.interest && (
                <div className="text-surface-700">
                  <span className="text-surface-500">Next step: </span>
                  {call.next_step}
                </div>
              )}
              {call.follow_up_at && (
                <div className="text-surface-700">
                  <span className="text-surface-500">Asked to be called at: </span>
                  {call.follow_up_at}
                </div>
              )}
            </div>
          )}

          {/* Recording — proxied through backend so vendor URL never reaches the browser */}
          {call.has_recording && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={togglePlay}
                className="btn-outline px-3 py-1.5 text-xs"
                title={playing ? 'Pause' : 'Play recording'}
              >
                {playing ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                {playing ? 'Pause' : 'Play recording'}
              </button>
              <audio
                ref={audioRef}
                src={api.recordingUrl(call.id)}
                preload="none"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                className="hidden"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Helpers ----------
function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-50 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-surface-500">
        {icon}
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums text-brand-navy mt-0.5">{value}</div>
    </div>
  );
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function statusLabel(status: string, answeredBy: string): string {
  if (status === 'COMPLETED' && answeredBy === 'HUMAN') return 'Picked up';
  if (status === 'COMPLETED' && answeredBy === 'MACHINE') return 'Voicemail';
  if (status === 'COMPLETED') return 'Completed';
  if (status === 'NOT_CONNECTED') return 'No answer';
  if (status === 'FAILED') return 'Failed';
  if (status === 'IN_PROGRESS') return 'In progress';
  if (status === 'SCHEDULED') return 'Scheduled';
  return status.replace('_', ' ').toLowerCase();
}

function statusTone(status: string, answeredBy: string): string {
  if (status === 'COMPLETED' && answeredBy === 'HUMAN') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'COMPLETED' && answeredBy === 'MACHINE') return 'bg-surface-100 text-surface-700 border-surface-200';
  if (status === 'NOT_CONNECTED') return 'bg-surface-100 text-surface-600 border-surface-200';
  if (status === 'FAILED') return 'bg-red-50 text-red-700 border-red-200';
  if (status === 'IN_PROGRESS') return 'bg-blue-50 text-blue-700 border-blue-200';
  return 'bg-surface-100 text-surface-700 border-surface-200';
}

function interestTone(interest: string): string {
  const i = interest.toLowerCase();
  if (i === 'high') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (i === 'medium') return 'bg-emerald-50/60 text-emerald-600 border-emerald-100';
  if (i.includes('callback')) return 'bg-brand-pink/10 text-brand-pink border-brand-pink/30';
  if (i.includes('objection') || i.includes('not interested') || i.includes('fees')) {
    return 'bg-amber-50 text-amber-700 border-amber-200';
  }
  return 'bg-surface-100 text-surface-700 border-surface-200';
}

function interestTextTone(interest: string): string {
  const i = interest.toLowerCase();
  if (i === 'high') return 'text-emerald-700';
  if (i === 'medium') return 'text-emerald-600';
  if (i.includes('not interested')) return 'text-red-700';
  if (i.includes('callback')) return 'text-brand-pink';
  return 'text-surface-700';
}
