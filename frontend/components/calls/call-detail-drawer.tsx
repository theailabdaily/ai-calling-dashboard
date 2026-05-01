'use client';
import { useQuery } from '@tanstack/react-query';
import { X, Phone, User, Bot, Clock, Repeat } from 'lucide-react';
import { format } from 'date-fns';
import { api, fmt } from '@/lib/api';
import { StatusBadge, Badge } from '@/components/ui/badge';
import JsonViewer from '@/components/ui/json-viewer';

type Props = {
  callId: string | null;
  onClose: () => void;
};

export default function CallDetailDrawer({ callId, onClose }: Props) {
  const { data: call, isLoading } = useQuery({
    queryKey: ['call', callId],
    queryFn: () => api.callDetail(callId!),
    enabled: !!callId,
  });

  if (!callId) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-brand-ink/40 backdrop-blur-sm z-40 transition-opacity"
      />

      {/* Drawer */}
      <aside className="fixed right-0 top-0 h-screen w-full max-w-2xl bg-surface-50 z-50 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-surface-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <div className="text-xs text-surface-500 uppercase tracking-wider">Call detail</div>
            <h2 className="text-lg font-semibold text-brand-navy">
              {call?.callee_name || call?.mobile_number || 'Loading…'}
            </h2>
          </div>
          <button onClick={onClose} className="btn-ghost p-2">
            <X size={18} />
          </button>
        </div>

        {isLoading || !call ? (
          <div className="p-12 text-center text-surface-500">Loading…</div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Status row */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={call.lifecycle_status} />
              <Badge tone={call.answered_by === 'HUMAN' ? 'success' : call.answered_by === 'MACHINE' ? 'warning' : 'neutral'}>
                {call.answered_by === 'HUMAN' ? 'Picked up by human' : call.answered_by === 'MACHINE' ? 'Voicemail' : 'Unknown pickup'}
              </Badge>
              {call.engagement_status === 'ENGAGED' && <Badge tone="success">Engaged</Badge>}
              {call.engagement_status === 'NOT_ENGAGED' && <Badge tone="warning">Not engaged</Badge>}
              {String(call.result.interested || '').toLowerCase() === 'yes' && <Badge tone="info">Interested</Badge>}
            </div>

            {/* Recording */}
            {call.recording_url ? (
              <div className="card p-4">
                <div className="text-xs uppercase tracking-wider text-surface-500 mb-2">Recording</div>
                <audio
                  controls
                  src={call.recording_url}
                  className="w-full"
                  preload="metadata"
                >
                  Your browser doesn't support audio playback.
                </audio>
              </div>
            ) : (
              <div className="card p-4 text-sm text-surface-500">
                No recording available for this call.
              </div>
            )}

            {/* Key facts grid */}
            <div className="grid grid-cols-2 gap-4">
              <Fact icon={<Phone size={14} />} label="Mobile">{call.mobile_number || '—'}</Fact>
              <Fact icon={<User size={14} />} label="Vendor">{call.vendor_name}</Fact>
              <Fact icon={<Bot size={14} />} label="Agent">{call.agent_name || '—'}</Fact>
              <Fact icon={<Clock size={14} />} label="Duration">
                {call.duration_seconds ? fmt.duration(call.duration_seconds) : '—'}
              </Fact>
              <Fact icon={<Repeat size={14} />} label="Retries">
                {call.retry_count} / {call.max_retries}
              </Fact>
              <Fact icon={<Clock size={14} />} label="Started">
                {call.started_at ? format(new Date(call.started_at), 'd MMM yyyy, HH:mm') : '—'}
              </Fact>
            </div>

            {call.campaign_name && (
              <div className="card p-4">
                <div className="text-xs uppercase tracking-wider text-surface-500 mb-1">Campaign</div>
                <div className="text-sm text-brand-navy font-medium">{call.campaign_name}</div>
              </div>
            )}

            {/* AI result — the heart of the QA flow */}
            <div>
              <h3 className="text-sm font-semibold text-brand-navy mb-2">AI extraction (result)</h3>
              <p className="text-xs text-surface-500 mb-2">
                Whatever fields the agent's result_schema is configured to extract.
              </p>
              <JsonViewer data={call.result} />
            </div>

            {/* Custom data — what we passed in */}
            <div>
              <h3 className="text-sm font-semibold text-brand-navy mb-2">Custom data (input)</h3>
              <p className="text-xs text-surface-500 mb-2">
                Metadata we attached when triggering the call.
              </p>
              <JsonViewer data={call.custom_data} />
            </div>

            {/* IDs for debugging */}
            <details className="text-xs text-surface-500">
              <summary className="cursor-pointer hover:text-surface-700">Debug IDs</summary>
              <div className="mt-2 space-y-1 font-mono">
                <div>internal: {call.id}</div>
                <div>vendor_call_id: {call.vendor_call_id}</div>
                {call.campaign_id && <div>campaign_id: {call.campaign_id}</div>}
                {call.agent_id && <div>agent_id: {call.agent_id}</div>}
              </div>
            </details>
          </div>
        )}
      </aside>
    </>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-1.5 text-xs text-surface-500 uppercase tracking-wider mb-1">
        {icon} {label}
      </div>
      <div className="text-sm font-medium text-brand-navy tabular-nums">{children}</div>
    </div>
  );
}
