'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Send, AlertCircle, CheckCircle2, ExternalLink, Upload, X, FileText,
  CornerDownRight,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { api } from '@/lib/api';
import type { TriggerCampaignResponse, Agent, Vendor } from '@/types';

// ---------------------------------------------------------------------------
// Tiny CSV parser — handles double-quoted fields, embedded commas, escaped
// quotes, CRLF/LF. Avoids a runtime dep for ~30 lines.
// ---------------------------------------------------------------------------
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }       // escaped quote
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field !== '' || cur.length) { cur.push(field); lines.push(cur); cur = []; field = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else field += c;
    }
  }
  if (field !== '' || cur.length) { cur.push(field); lines.push(cur); }
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].map(h => h.trim());
  const rows = lines.slice(1)
    .filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));
  return { headers, rows };
}

// E.164-ish for Indian numbers — accept 10-digit, +91-prefixed, 91-prefixed.
// Returns the normalized "+91..." form, or null if invalid.
function normalizeIndianMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && /^91[6-9]/.test(digits)) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('091')) return `+${digits.slice(1)}`;
  return null;
}

// Auto-pick a column when its header matches a likely pattern
function autoDetectColumn(headers: string[], patterns: string[]): string {
  for (const p of patterns) {
    const hit = headers.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === p);
    if (hit) return hit;
  }
  for (const p of patterns) {
    const hit = headers.find(h => h.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return '';
}

type Tab = 'csv' | 'sheet';

export default function LaunchCampaignPage() {
  const vendors = useQuery({ queryKey: ['vendors'], queryFn: api.vendors });
  const agents  = useQuery({ queryKey: ['agents'],  queryFn: api.agents });

  const [tab, setTab] = useState<Tab>('csv');
  const [vendorSlug, setVendorSlug] = useState('hunar');
  const [agentInternalId, setAgentInternalId] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [result, setResult] = useState<TriggerCampaignResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve internal agent id → vendor's own ID (which is what the API needs)
  const selectedVendor = vendors.data?.find((v: Vendor) => v.slug === vendorSlug);
  const vendorAgents: Agent[] = (agents.data || []).filter((a: Agent) => a.vendor_id === selectedVendor?.id);
  const selectedAgent = vendorAgents.find(a => a.id === agentInternalId);

  // ---------- CSV state ----------
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [nameCol, setNameCol] = useState<string>('');
  const [phoneCol, setPhoneCol] = useState<string>('');
  const [removeInvalid, setRemoveInvalid] = useState(true);
  const [removeDupes, setRemoveDupes] = useState(true);

  const handleFile = async (file: File) => {
    setError(null);
    setCsvFile(file);
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    setCsvHeaders(headers);
    setCsvRows(rows);
    setNameCol(autoDetectColumn(headers, ['calleename', 'name', 'fullname', 'firstname']));
    setPhoneCol(autoDetectColumn(headers, ['mobilenumber', 'mobile', 'phone', 'phonenumber', 'contact']));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  // Build the cleaned recipient list whenever inputs change
  const cleaned = useMemo(() => {
    if (!csvRows.length || !nameCol || !phoneCol) return { valid: [], invalid: 0, dupes: 0 };
    const seen = new Set<string>();
    let invalid = 0, dupes = 0;
    const valid: { callee_name: string; mobile_number: string; custom_data: Record<string, string> }[] = [];
    for (const row of csvRows) {
      const rawName = row[nameCol]?.trim();
      const rawPhone = row[phoneCol]?.trim();
      const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
      if (!rawName || !phone) {
        if (removeInvalid) { invalid++; continue; }
      }
      if (phone && seen.has(phone)) {
        if (removeDupes) { dupes++; continue; }
      }
      if (phone) seen.add(phone);
      const custom: Record<string, string> = {};
      for (const h of csvHeaders) {
        if (h !== nameCol && h !== phoneCol && row[h]) custom[h] = row[h];
      }
      valid.push({
        callee_name: rawName || '(no name)',
        mobile_number: phone || rawPhone || '',
        custom_data: custom,
      });
    }
    return { valid, invalid, dupes };
  }, [csvRows, csvHeaders, nameCol, phoneCol, removeInvalid, removeDupes]);

  const launch = useMutation({
    mutationFn: api.pushRecipients,
    onSuccess: (data) => { setResult(data); setError(null); },
    onError: (err: Error) => { setError(err.message || 'Launch failed'); setResult(null); },
  });

  const canLaunchCsv = !!selectedAgent && cleaned.valid.length > 0 && !launch.isPending;

  const handleLaunchCsv = () => {
    if (!canLaunchCsv || !selectedAgent) return;
    setError(null);
    setResult(null);
    launch.mutate({
      vendor_slug: vendorSlug,
      vendor_agent_id: selectedAgent.vendor_agent_id,
      campaign_name: campaignName || undefined,
      recipients: cleaned.valid,
    });
  };

  // ---------- Sheet state (kept as alt path) ----------
  const [sheetId, setSheetId] = useState('');
  const [worksheetName, setWorksheetName] = useState('');
  const [maxRecipients, setMaxRecipients] = useState<number | ''>('');

  const sheetLaunch = useMutation({
    mutationFn: api.triggerCampaign,
    onSuccess: (data) => { setResult(data); setError(null); },
    onError: (err: Error) => { setError(err.message || 'Launch failed'); setResult(null); },
  });

  const canLaunchSheet = !!selectedAgent && !!sheetId && !sheetLaunch.isPending;
  const handleLaunchSheet = () => {
    if (!canLaunchSheet || !selectedAgent) return;
    setError(null);
    setResult(null);
    sheetLaunch.mutate({
      vendor_slug: vendorSlug,
      vendor_agent_id: selectedAgent.vendor_agent_id,
      sheet_id: sheetId,
      worksheet_name: worksheetName || undefined,
      campaign_name: campaignName || undefined,
      max_recipients: maxRecipients ? Number(maxRecipients) : undefined,
    });
  };

  const launching = launch.isPending || sheetLaunch.isPending;

  return (
    <div className="p-6 max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-brand-navy">Launch campaign</h1>
        <p className="text-sm text-surface-500 mt-1">
          Upload a CSV or pull from a Google Sheet. We'll dedupe, validate Indian phone numbers, and dial through your vendor.
        </p>
      </header>

      {/* Common fields — vendor + agent + campaign name */}
      <div className="card p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Vendor" hint="Where you're sending the calls">
            <select
              value={vendorSlug}
              onChange={e => { setVendorSlug(e.target.value); setAgentInternalId(''); }}
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            >
              {(vendors.data || []).map((v: Vendor) => (
                <option key={v.id} value={v.slug}>{v.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Agent / script" hint="Pick from agents synced from the vendor">
            <select
              value={agentInternalId}
              onChange={e => setAgentInternalId(e.target.value)}
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            >
              <option value="">— Select agent —</option>
              {vendorAgents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} {a.language ? `(${a.language})` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Campaign name" hint="Optional — defaults to today's date">
          <input
            type="text"
            value={campaignName}
            onChange={e => setCampaignName(e.target.value)}
            placeholder="e.g. UGC NET reactivation — May 2"
            className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
          />
        </Field>
      </div>

      {/* Tabs — CSV vs Sheet */}
      <div className="flex gap-1 border-b border-surface-200">
        <TabButton active={tab === 'csv'}   onClick={() => setTab('csv')}   icon={<FileText size={14} />} label="Upload CSV" />
        <TabButton active={tab === 'sheet'} onClick={() => setTab('sheet')} icon={<ExternalLink size={14} />} label="Google Sheet" />
      </div>

      {tab === 'csv' && (
        <div className="space-y-4">
          {/* Drop zone */}
          {!csvFile ? (
            <div
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              className="card border-2 border-dashed border-surface-300 p-12 text-center hover:border-brand-pink/50 transition-colors"
            >
              <Upload size={32} className="mx-auto mb-3 text-surface-400" />
              <label className="cursor-pointer">
                <span className="text-sm font-medium text-brand-navy">Drop a CSV here, or click to upload</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
              </label>
              <p className="text-xs text-surface-500 mt-2">
                Headers required. We'll let you map columns next. CSV ≤ 20 MB.
              </p>
            </div>
          ) : (
            <div className="card p-4 flex items-center gap-3">
              <FileText size={18} className="text-brand-pink shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-brand-navy truncate">{csvFile.name}</div>
                <div className="text-xs text-surface-500">
                  {(csvFile.size / 1024).toFixed(1)} KB · {csvRows.length} rows · {csvHeaders.length} columns
                </div>
              </div>
              <button
                onClick={() => { setCsvFile(null); setCsvHeaders([]); setCsvRows([]); setNameCol(''); setPhoneCol(''); }}
                className="text-surface-400 hover:text-surface-700"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Column mapping */}
          {csvFile && csvHeaders.length > 0 && (
            <div className="card p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-brand-navy">Map columns</h3>
                <p className="text-xs text-surface-500 mt-0.5">
                  Pick which CSV column holds the name and the phone number. Other columns ride along as <code className="text-[11px] bg-surface-100 px-1 rounded">custom_data</code>.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="callee_name" required>
                  <select value={nameCol} onChange={e => setNameCol(e.target.value)} className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30">
                    <option value="">— Choose column —</option>
                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
                <Field label="mobile_number" required>
                  <select value={phoneCol} onChange={e => setPhoneCol(e.target.value)} className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30">
                    <option value="">— Choose column —</option>
                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
              </div>

              <div className="space-y-2 pt-2">
                <Toggle
                  checked={removeInvalid}
                  onChange={setRemoveInvalid}
                  label="Remove invalid rows"
                  hint="Drop rows missing a name or with a phone number that isn't a valid 10-digit Indian mobile."
                />
                <Toggle
                  checked={removeDupes}
                  onChange={setRemoveDupes}
                  label="Remove duplicate phone numbers"
                  hint="Keep only the first row per unique mobile number."
                />
              </div>

              {nameCol && phoneCol && (
                <div className="rounded-lg bg-surface-50 px-4 py-3 flex items-center gap-3 text-sm">
                  <CornerDownRight size={14} className="text-brand-pink" />
                  <span>
                    <strong className="text-brand-navy tabular-nums">{cleaned.valid.length}</strong> valid recipients
                    {cleaned.invalid > 0 && <span className="text-surface-500"> · {cleaned.invalid} dropped (invalid)</span>}
                    {cleaned.dupes > 0 && <span className="text-surface-500"> · {cleaned.dupes} dropped (duplicate)</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Preview table */}
          {nameCol && phoneCol && cleaned.valid.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-brand-navy">
                  Preview ({cleaned.valid.length} entries)
                </h3>
                <span className="text-xs text-surface-500">Showing first 10</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-surface-500 bg-surface-50">
                      <th className="px-5 py-2 font-medium">callee_name</th>
                      <th className="px-3 py-2 font-medium">mobile_number</th>
                      <th className="px-3 py-2 font-medium">custom_data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cleaned.valid.slice(0, 10).map((r, i) => (
                      <tr key={i} className="border-t border-surface-100">
                        <td className="px-5 py-2 font-medium text-brand-navy">{r.callee_name}</td>
                        <td className="px-3 py-2 tabular-nums">{r.mobile_number}</td>
                        <td className="px-3 py-2 text-xs text-surface-500 truncate max-w-[400px]">
                          {Object.keys(r.custom_data).length
                            ? Object.entries(r.custom_data).map(([k, v]) => `${k}=${v}`).join(' · ')
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Launch */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleLaunchCsv}
              disabled={!canLaunchCsv}
              className="btn bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={14} />
              {launch.isPending ? 'Launching…' : `Launch campaign${cleaned.valid.length ? ` (${cleaned.valid.length})` : ''}`}
            </button>
            <span className="text-xs text-surface-500">
              {!selectedAgent ? 'Pick an agent first.' :
               !cleaned.valid.length ? 'Upload a CSV and map columns.' :
               'Will dial every recipient immediately.'}
            </span>
          </div>
        </div>
      )}

      {tab === 'sheet' && (
        <div className="card p-6 space-y-4">
          <Field label="Google Sheet ID" hint="From the URL: docs.google.com/spreadsheets/d/THIS_PART/edit">
            <input
              type="text"
              value={sheetId}
              onChange={e => setSheetId(e.target.value)}
              placeholder="1abcDEF…"
              className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Worksheet name" hint="Optional — defaults to first sheet">
              <input type="text" value={worksheetName} onChange={e => setWorksheetName(e.target.value)} placeholder="Sheet1" className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30" />
            </Field>
            <Field label="Max recipients" hint="Safety cap on number of calls">
              <input type="number" value={maxRecipients} onChange={e => setMaxRecipients(e.target.value ? Number(e.target.value) : '')} placeholder="e.g. 500" className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink/30" />
            </Field>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900 flex gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <div>
              Sheet must have a header row with at least: <code className="px-1 bg-amber-100 rounded">name</code>, <code className="px-1 bg-amber-100 rounded">mobile_number</code>. Optional: <code className="px-1 bg-amber-100 rounded">email</code>. Any extra columns become <code className="px-1 bg-amber-100 rounded">custom_data</code>.
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleLaunchSheet}
              disabled={!canLaunchSheet}
              className="btn bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={14} />
              {sheetLaunch.isPending ? 'Launching…' : 'Launch campaign'}
            </button>
            <span className="text-xs text-surface-500">
              {!selectedAgent ? 'Pick an agent first.' :
               !sheetId ? 'Paste the Google Sheet ID.' :
               'Will dial every row in the sheet.'}
            </span>
          </div>
        </div>
      )}

      {/* Result / error */}
      {error && (
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-900 flex items-start gap-2">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Launch failed</div>
            <div className="text-xs mt-0.5 break-all">{error}</div>
          </div>
        </div>
      )}
      {result && (
        <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold">Campaign launched</div>
              <div className="text-xs mt-1 space-y-0.5">
                <div>Status: <strong>{result.status}</strong></div>
                <div>Request ID: <code className="bg-emerald-100 px-1 rounded">{result.request_id || '—'}</code></div>
                <div>Recipients pushed: <strong className="tabular-nums">{result.recipients_pushed}</strong></div>
                {result.warning && <div className="text-amber-800 mt-1">{result.warning}</div>}
              </div>
              <Link href="/" className="text-xs text-emerald-700 hover:underline mt-2 inline-block">
                ← Back to dashboard
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Local UI helpers ----------
function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-brand-navy">
        {label} {required && <span className="text-brand-pink">*</span>}
      </div>
      {hint && <div className="text-xs text-surface-500 mt-0.5 mb-1.5">{hint}</div>}
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-0.5 accent-brand-pink" />
      <div>
        <div className="text-sm text-brand-navy font-medium">{label}</div>
        {hint && <div className="text-xs text-surface-500">{hint}</div>}
      </div>
    </label>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
        (active ? 'border-brand-pink text-brand-navy' : 'border-transparent text-surface-500 hover:text-surface-700')
      }
    >
      {icon} {label}
    </button>
  );
}
