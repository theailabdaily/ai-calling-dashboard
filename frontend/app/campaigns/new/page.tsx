'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Send, AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';

import { api } from '@/lib/api';
import type { TriggerCampaignResponse } from '@/types';

export default function LaunchCampaignPage() {
  const vendors = useQuery({ queryKey: ['vendors'], queryFn: api.vendors });
  const agents  = useQuery({ queryKey: ['agents'],  queryFn: api.agents });

  const [vendorSlug, setVendorSlug] = useState('hunar');
  const [vendorAgentId, setVendorAgentId] = useState('');     // we need the vendor's ID, not our internal UUID
  const [sheetId, setSheetId] = useState('');
  const [worksheetName, setWorksheetName] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [maxRecipients, setMaxRecipients] = useState<number | ''>('');

  const [result, setResult] = useState<TriggerCampaignResponse | null>(null);

  const launch = useMutation({
    mutationFn: api.triggerCampaign,
    onSuccess: setResult,
  });

  // Filter agents to selected vendor. (We need the vendor_agent_id which isn't in
  // our /api/agents response yet — so v1 asks the user to paste it from the vendor UI.)
  const selectedVendor = vendors.data?.find(v => v.slug === vendorSlug);
  const vendorAgents = (agents.data || []).filter(a => a.vendor_id === selectedVendor?.id);

  const canSubmit = vendorSlug && vendorAgentId && sheetId && !launch.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setResult(null);
    launch.mutate({
      vendor_slug: vendorSlug,
      vendor_agent_id: vendorAgentId,
      sheet_id: sheetId,
      worksheet_name: worksheetName || undefined,
      campaign_name: campaignName || undefined,
      max_recipients: maxRecipients ? Number(maxRecipients) : undefined,
    });
  };

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Launch campaign</h1>
        <p className="text-sm text-surface-500 mt-1">
          Pull leads from a Google Sheet and dial them through your AI calling vendor.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="card p-6 space-y-5">
        {/* Step 1: vendor */}
        <Field label="Vendor" hint="Where you're sending the calls">
          <select
            value={vendorSlug}
            onChange={e => setVendorSlug(e.target.value)}
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
          >
            {(vendors.data || []).map(v => (
              <option key={v.id} value={v.slug}>{v.name}</option>
            ))}
          </select>
        </Field>

        {/* Step 2: agent */}
        <Field label="Agent / script" hint={`Pick from agents synced from ${selectedVendor?.name || 'vendor'}, or paste the vendor's agent ID directly.`}>
          {vendorAgents.length > 0 ? (
            <select
              value={vendorAgentId}
              onChange={e => setVendorAgentId(e.target.value)}
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            >
              <option value="">— select an agent —</option>
              {vendorAgents.map(a => (
                <option key={a.id} value={a.vendor_agent_id}>{a.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={vendorAgentId}
              onChange={e => setVendorAgentId(e.target.value)}
              placeholder="Paste vendor's agent_id (e.g. from the Hunar dashboard)"
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            />
          )}
        </Field>

        {/* Step 3: sheet */}
        <Field label="Google Sheet ID" hint="From the URL: docs.google.com/spreadsheets/d/THIS_PART/edit">
          <input
            type="text"
            value={sheetId}
            onChange={e => setSheetId(e.target.value)}
            placeholder="1abcDEF…"
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Worksheet name" hint="Optional — defaults to first sheet">
            <input
              type="text"
              value={worksheetName}
              onChange={e => setWorksheetName(e.target.value)}
              placeholder="Sheet1"
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            />
          </Field>
          <Field label="Max recipients" hint="Safety cap on number of calls">
            <input
              type="number"
              value={maxRecipients}
              onChange={e => setMaxRecipients(e.target.value ? Number(e.target.value) : '')}
              placeholder="e.g. 500"
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            />
          </Field>
        </div>

        <Field label="Campaign name" hint="Optional — defaults to today's date">
          <input
            type="text"
            value={campaignName}
            onChange={e => setCampaignName(e.target.value)}
            placeholder="Q4 SSC reactivation"
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
          />
        </Field>

        {/* Sheet shape reminder */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-900">
          <div className="font-semibold mb-1 flex items-center gap-1.5">
            <AlertCircle size={14} /> Sheet must have these columns
          </div>
          Header row required: <code className="font-mono">name</code>, <code className="font-mono">mobile_number</code>{' '}
          (10-digit Indian numbers auto-prefixed with +91), optional <code className="font-mono">email</code>.
          Any extra columns become <code className="font-mono">custom_data</code> on each call.
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
            {launch.isPending ? 'Launching…' : 'Launch campaign'}
          </button>
          <span className="text-xs text-surface-500">
            This will dial every recipient in the sheet immediately. Use Max recipients to test first.
          </span>
        </div>

        {launch.isError && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-sm text-rose-900 flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Launch failed</div>
              <div className="text-xs mt-1">{(launch.error as Error)?.message}</div>
            </div>
          </div>
        )}
      </form>

      {result && <LaunchResult result={result} />}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-brand-navy">{label}</span>
      {hint && <span className="block text-xs text-surface-500 mb-1.5 mt-0.5">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function LaunchResult({ result }: { result: TriggerCampaignResponse }) {
  const ok = result.status === 'launched';
  return (
    <div className={`card p-5 border-l-4 ${ok ? 'border-l-emerald-500' : 'border-l-amber-500'}`}>
      <div className="flex items-start gap-2 mb-3">
        {ok ? <CheckCircle2 size={20} className="text-emerald-600" /> : <AlertCircle size={20} className="text-amber-600" />}
        <div>
          <div className="font-semibold text-brand-navy">
            {ok ? 'Campaign launched' : 'No calls dialed'}
          </div>
          {result.warning && <div className="text-xs text-surface-500 mt-1">{result.warning}</div>}
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Sheet rows added" value={result.sheet_rows_inserted} />
        <Stat label="Calls dialed" value={result.recipients_pushed} />
        <Stat label="Request ID" value={result.request_id || '—'} mono />
      </dl>

      {ok && (
        <div className="mt-4 pt-4 border-t border-surface-200">
          <Link href="/" className="btn-outline text-xs">
            View on dashboard <ExternalLink size={12} />
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-surface-500">{label}</dt>
      <dd className={`mt-1 font-semibold text-brand-navy ${mono ? 'font-mono text-xs' : 'text-lg tabular-nums'}`}>
        {value}
      </dd>
    </div>
  );
}
