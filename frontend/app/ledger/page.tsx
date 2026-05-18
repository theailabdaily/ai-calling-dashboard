'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ScrollText, Plus, X, Trash2, Edit3, ChevronDown, AlertCircle,
  ListPlus, Megaphone, FileText, Settings, Sparkles,
} from 'lucide-react';

import { api, fmt } from '@/lib/api';
import { useRequireProductLine } from '@/lib/use-product-line';
import {
  LEDGER_ENTRY_TYPES,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerEntryInput,
  type PendingCampaign,
} from '@/types';

// Type → human label + icon + tone
const TYPE_META: Record<LedgerEntryType, { label: string; icon: typeof ListPlus; tone: string }> = {
  leads_given:      { label: 'Leads given',      icon: ListPlus,  tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  campaign_created: { label: 'Campaign created', icon: Megaphone, tone: 'bg-sky-50 text-sky-700 border-sky-200' },
  note:             { label: 'Note',             icon: FileText,  tone: 'bg-surface-100 text-surface-700 border-surface-200' },
  config_change:    { label: 'Config change',    icon: Settings,  tone: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const TYPE_OPTIONS: { value: LedgerEntryType | ''; label: string }[] = [
  { value: '',                  label: 'All types' },
  { value: 'leads_given',       label: 'Leads given' },
  { value: 'campaign_created',  label: 'Campaign created' },
  { value: 'note',              label: 'Note' },
  { value: 'config_change',     label: 'Config change' },
];

export default function LedgerPage() {
  const ready = useRequireProductLine();

  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<LedgerEntryType | ''>('');
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  // When the user clicks a pending-campaign chip, we open the form pre-linked
  // to that campaign. `prefill` carries the seed values; null means a clean
  // form (e.g. plain "+ New entry" button click).
  const [prefill, setPrefill] = useState<Partial<LedgerEntryInput> | null>(null);

  const list = useQuery({
    queryKey: ['ledger', typeFilter, page],
    queryFn: () => api.ledgerList({
      entry_type: typeFilter || undefined,
      page,
      page_size: 25,
    }),
  });

  const pending = useQuery({
    queryKey: ['ledger-pending'],
    queryFn: () => api.ledgerPendingCampaigns(30),
  });

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1;

  const deleteEntry = useMutation({
    mutationFn: (id: string) => api.ledgerDelete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: ['ledger-pending'] });
    },
  });

  const handleDelete = (entry: LedgerEntry) => {
    if (!confirm(`Delete "${entry.title}"? This can't be undone.`)) return;
    deleteEntry.mutate(entry.id);
  };

  const openFormForCampaign = (c: PendingCampaign) => {
    setEditing(null);
    setPrefill({
      entry_type: 'leads_given',
      title: `${c.vendor_name} — ${c.campaign_name}`,
      vendor_id: c.vendor_id,
      campaign_id: c.campaign_id,
      // Seed leads_unique from live data so the field is populated immediately.
      // The form will also re-fetch when the campaign is changed; this is just
      // a faster initial paint.
      leads_unique: c.unique_leads || null,
      leads_total: c.total_calls || null,
    });
    setShowForm(true);
  };

  // Hard scope gate — render nothing until we know the product line
  if (!ready) return null;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-[1200px] mx-auto">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-brand-navy flex items-center gap-2">
            <ScrollText size={22} className="text-brand-pink" />
            Activity Log
          </h1>
          <p className="text-xs md:text-sm text-surface-500 mt-1">
            Journal of leads given to vendors, campaigns created, prompt changes, and other ops actions.
            Linked campaigns auto-show live dialed/connected numbers.
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setPrefill(null); setShowForm(s => !s); }}
          className="btn bg-brand-pink text-white hover:bg-[#d92853] shrink-0"
        >
          <Plus size={14} /> <span className="hidden sm:inline">New entry</span>
        </button>
      </header>

      {/* Pending-campaigns banner — surfaces campaigns that exist in the DB
          but have no journal entry yet. Click a chip to open the form
          pre-linked to that campaign with leads_unique already populated. */}
      {pending.data && pending.data.total > 0 && (
        <PendingBanner
          items={pending.data.items}
          onPick={openFormForCampaign}
        />
      )}

      {(showForm || editing) && (
        <EntryForm
          initial={editing || undefined}
          prefill={prefill || undefined}
          onClose={() => { setShowForm(false); setEditing(null); setPrefill(null); }}
          onSaved={() => {
            setShowForm(false);
            setEditing(null);
            setPrefill(null);
            qc.invalidateQueries({ queryKey: ['ledger'] });
            qc.invalidateQueries({ queryKey: ['ledger-pending'] });
          }}
        />
      )}

      {/* Filter bar */}
      <div className="card p-3 md:p-4 flex flex-wrap items-center gap-2 md:gap-3">
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value as LedgerEntryType | ''); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {TYPE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="text-xs text-surface-500 ml-auto tabular-nums">
          {list.data ? `${fmt.int(list.data.total)} ${list.data.total === 1 ? 'entry' : 'entries'}` : '—'}
        </span>
      </div>

      {/* List */}
      {list.isLoading && (
        <div className="card p-6 text-sm text-surface-500">Loading entries…</div>
      )}

      {list.data && list.data.items.length === 0 && (
        <div className="card p-8 text-center">
          <ScrollText size={28} className="text-surface-300 mx-auto mb-2" />
          <p className="text-sm text-surface-600 font-medium">No entries yet</p>
          <p className="text-xs text-surface-500 mt-1">
            Click <strong>New entry</strong> to log your first leads-given batch or campaign.
          </p>
        </div>
      )}

      <div className="space-y-2 md:space-y-3">
        {(list.data?.items || []).map(entry => (
          <EntryCard
            key={entry.id}
            entry={entry}
            onEdit={() => { setShowForm(false); setEditing(entry); }}
            onDelete={() => handleDelete(entry)}
          />
        ))}
      </div>

      {/* Pagination */}
      {list.data && totalPages > 1 && (
        <div className="flex items-center justify-between text-xs px-1">
          <span className="text-surface-500">Page {page} of {totalPages}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-outline px-3 py-1.5 disabled:opacity-40"
            >Previous</button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="btn-outline px-3 py-1.5 disabled:opacity-40"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Pending-campaigns banner ----------
// Campaigns that exist but have no ledger entry yet — every campaign deserves
// a journal note, so we surface the gap loudly. Clicking a chip opens the
// New Entry form pre-linked to that campaign.
function PendingBanner({
  items, onPick,
}: { items: PendingCampaign[]; onPick: (c: PendingCampaign) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 3);
  const more = items.length - visible.length;

  return (
    <div className="card p-3 md:p-4 border-amber-200 bg-amber-50">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-900">
            {items.length} campaign{items.length === 1 ? '' : 's'} without a log entry
          </div>
          <div className="text-xs text-amber-800/80 mt-0.5">
            Click a campaign to log it — leads sent will auto-fill from live data.
          </div>

          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {visible.map(c => (
              <button
                key={c.campaign_id}
                onClick={() => onPick(c)}
                className="group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-amber-300 hover:border-amber-500 hover:bg-amber-100 transition-colors text-left max-w-full"
                title={`${c.vendor_name} · ${c.campaign_name}`}
              >
                <span className="text-[11px] font-medium text-amber-900 truncate">
                  {c.vendor_name} · {c.campaign_name.length > 28 ? c.campaign_name.slice(0, 28) + '…' : c.campaign_name}
                </span>
                {c.unique_leads > 0 && (
                  <span className="text-[10px] tabular-nums text-amber-700 bg-amber-100 px-1 rounded shrink-0">
                    {fmt.int(c.unique_leads)} unique
                  </span>
                )}
                {c.started_at && (
                  <span className="text-[10px] text-amber-700/70 shrink-0">
                    {c.started_at.slice(0, 10)}
                  </span>
                )}
              </button>
            ))}
            {more > 0 && (
              <button
                onClick={() => setExpanded(true)}
                className="text-[11px] text-amber-700 hover:text-amber-900 underline px-2 py-1.5"
              >
                + {more} more
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Entry card ----------
function EntryCard({
  entry, onEdit, onDelete,
}: { entry: LedgerEntry; onEdit: () => void; onDelete: () => void }) {
  const [showNotes, setShowNotes] = useState(false);
  const meta = TYPE_META[entry.entry_type] || TYPE_META.note;
  const Icon = meta.icon;
  const occurred = new Date(entry.occurred_at);
  const live = entry.live_stats;

  // If user logged a leads_total but vendor reports fewer/more dialed, that's
  // a delivery-gap signal worth surfacing.
  const sentVsDialedGap =
    entry.leads_total != null && live ? entry.leads_total - live.total_calls : null;

  return (
    <div className="card p-3 md:p-4">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${meta.tone}`}>
          <Icon size={16} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`pill ${meta.tone} border`}>{meta.label}</span>
                {entry.vendor_name && (
                  <span className="text-xs text-surface-500">{entry.vendor_name}</span>
                )}
                {entry.campaign_name && (
                  <span className="text-xs text-surface-500 truncate" title={entry.campaign_name}>
                    · {entry.campaign_name}
                  </span>
                )}
              </div>
              <h3 className="text-sm md:text-base font-semibold text-brand-navy mt-1">
                {entry.title}
              </h3>
              <div className="text-xs text-surface-500 mt-0.5" title={format(occurred, 'd MMM yyyy, HH:mm')}>
                {formatDistanceToNow(occurred, { addSuffix: true })}
                <span className="hidden sm:inline"> · {format(occurred, 'd MMM yyyy, HH:mm')}</span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onEdit}
                className="btn-ghost p-1.5"
                title="Edit"
                aria-label="Edit entry"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={onDelete}
                className="btn-ghost p-1.5 hover:text-red-600"
                title="Delete"
                aria-label="Delete entry"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Counts row — what user logged + (if linked) what vendor actually did */}
          {(entry.leads_total != null || entry.leads_unique != null || live) && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-xs">
              {entry.leads_total != null && (
                <Stat label="Logged total" value={fmt.int(entry.leads_total)} accent />
              )}
              {entry.leads_unique != null && (
                <Stat label="Logged unique" value={fmt.int(entry.leads_unique)} accent />
              )}
              {live && (
                <>
                  <Stat label="Dialed (live)" value={fmt.int(live.total_calls)} />
                  <Stat label="Connected" value={fmt.int(live.connected)} />
                  <Stat label="Interested" value={fmt.int(live.interested)} />
                </>
              )}
            </div>
          )}

          {/* Sent vs dialed gap warning */}
          {sentVsDialedGap !== null && Math.abs(sentVsDialedGap) > 5 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
              <AlertCircle size={12} />
              {sentVsDialedGap > 0
                ? `${fmt.int(sentVsDialedGap)} logged leads not yet reflected in vendor dial volume`
                : `Vendor dialed ${fmt.int(-sentVsDialedGap)} more than logged — possible duplicate or unrelated calls`}
            </div>
          )}

          {/* Notes (collapsed) */}
          {entry.notes && (
            <div className="mt-2">
              <button
                onClick={() => setShowNotes(s => !s)}
                className="text-xs text-surface-600 hover:text-brand-navy flex items-center gap-1"
              >
                <ChevronDown size={12} className={showNotes ? '' : '-rotate-90'} />
                {showNotes ? 'Hide notes' : 'Show notes'}
              </button>
              {showNotes && (
                <p className="mt-1.5 text-xs text-surface-700 whitespace-pre-wrap leading-relaxed">
                  {entry.notes}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-md px-2 py-1.5 ${accent ? 'bg-brand-pink/5' : 'bg-surface-50'}`}>
      <div className="text-[10px] uppercase tracking-wider text-surface-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ? 'text-brand-pink' : 'text-brand-navy'}`}>
        {value}
      </div>
    </div>
  );
}

// ---------- Form ----------
function EntryForm({
  initial, prefill, onClose, onSaved,
}: {
  initial?: LedgerEntry;
  prefill?: Partial<LedgerEntryInput>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const vendorsQ = useQuery({ queryKey: ['vendors'], queryFn: api.vendors });
  const campaignsQ = useQuery({ queryKey: ['campaigns'], queryFn: api.campaigns });

  const [form, setForm] = useState<LedgerEntryInput>({
    entry_type: (initial?.entry_type as LedgerEntryType) || prefill?.entry_type || 'leads_given',
    title: initial?.title || prefill?.title || '',
    occurred_at: initial?.occurred_at,
    vendor_id: initial?.vendor_id ?? prefill?.vendor_id ?? null,
    campaign_id: initial?.campaign_id ?? prefill?.campaign_id ?? null,
    leads_total: initial?.leads_total ?? prefill?.leads_total ?? null,
    leads_unique: initial?.leads_unique ?? prefill?.leads_unique ?? null,
    notes: initial?.notes || null,
  });
  const [error, setError] = useState<string | null>(null);
  // Track which numeric fields the user has typed into manually. Pre-existing
  // values from a saved entry (`initial`) count as touched — we don't want to
  // overwrite what someone deliberately saved. Pre-filled values from a chip
  // click do NOT count — they came from the same auto-fetch source the
  // useEffect will use, so it's fine to refresh them when campaign changes.
  const [touched, setTouched] = useState<{ total: boolean; unique: boolean }>({
    total: initial?.leads_total != null,
    unique: initial?.leads_unique != null,
  });
  // Tag fields auto-filled from campaign data so we can surface a small
  // "(auto)" hint and explain where the number came from.
  const [autofilled, setAutofilled] = useState<{ total: boolean; unique: boolean }>({
    total: !initial && prefill?.leads_total != null,
    unique: !initial && prefill?.leads_unique != null,
  });

  const visibleCampaigns = (campaignsQ.data || []).filter(
    c => !form.vendor_id || c.vendor_id === form.vendor_id
  );

  // When the campaign changes (and isn't being edited from a saved entry),
  // pull live stats so unique/total leads auto-populate. Skip when the user
  // has already typed into either field — we don't clobber their input.
  useEffect(() => {
    if (isEdit) return;                  // editing: respect what's saved
    if (!form.campaign_id) return;       // nothing to fetch
    let cancelled = false;
    (async () => {
      try {
        const stats = await api.ledgerCampaignStats(form.campaign_id!);
        if (cancelled) return;
        setForm(prev => ({
          ...prev,
          leads_unique: touched.unique ? prev.leads_unique : (stats.unique_leads || null),
          leads_total:  touched.total  ? prev.leads_total  : (stats.total_calls || null),
        }));
        setAutofilled({
          unique: !touched.unique && stats.unique_leads > 0,
          total:  !touched.total  && stats.total_calls > 0,
        });
      } catch {
        // Silent — campaign might be too new for stats; user can type manually.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.campaign_id]);

  const submit = async () => {
    setError(null);
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    try {
      if (isEdit && initial) {
        await api.ledgerUpdate(initial.id, form);
      } else {
        await api.ledgerCreate(form);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const showLeadsCounts = form.entry_type === 'leads_given';

  return (
    <div className="card p-4 md:p-5 border-brand-pink/30 bg-gradient-to-br from-white to-brand-pink/5">
      <div className="flex items-start justify-between gap-2 mb-4">
        <h2 className="text-base font-semibold text-brand-navy">
          {isEdit ? 'Edit entry' : 'New entry'}
        </h2>
        <button onClick={onClose} className="btn-ghost p-1.5"><X size={16} /></button>
      </div>

      <div className="space-y-3">
        {/* Type + title */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Type</Label>
            <select
              value={form.entry_type}
              onChange={e => setForm({ ...form, entry_type: e.target.value as LedgerEntryType })}
              className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white"
            >
              {LEDGER_ENTRY_TYPES.map(t => (
                <option key={t} value={t}>{TYPE_META[t].label}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label>Title *</Label>
            <input
              type="text"
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. SSC June drop 1 — interest cohort"
              className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm"
            />
          </div>
        </div>

        {/* Vendor + campaign */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Vendor (optional)</Label>
            <select
              value={form.vendor_id || ''}
              onChange={e => setForm({ ...form, vendor_id: e.target.value || null, campaign_id: null })}
              className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white"
            >
              <option value="">— None —</option>
              {(vendorsQ.data || []).map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Campaign (optional)</Label>
            <select
              value={form.campaign_id || ''}
              onChange={e => setForm({ ...form, campaign_id: e.target.value || null })}
              className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm bg-white"
              disabled={!visibleCampaigns.length}
            >
              <option value="">— None (link to live stats) —</option>
              {visibleCampaigns.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.started_at ? ` (${c.started_at.slice(0, 10)})` : ''}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-surface-500 mt-0.5">
              Linking lets the dashboard pull live dialed/connected numbers.
            </div>
          </div>
        </div>

        {/* Leads counts — only when relevant */}
        {showLeadsCounts && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Leads sent (total)
                {autofilled.total && !touched.total && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-normal text-brand-pink">
                    <Sparkles size={10} /> auto
                  </span>
                )}
              </Label>
              <input
                type="number"
                min={0}
                value={form.leads_total ?? ''}
                onChange={e => {
                  setTouched(t => ({ ...t, total: true }));
                  setAutofilled(a => ({ ...a, total: false }));
                  setForm({ ...form, leads_total: e.target.value === '' ? null : Number(e.target.value) });
                }}
                className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm tabular-nums"
                placeholder="500"
              />
            </div>
            <div>
              <Label>
                Leads sent (unique)
                {autofilled.unique && !touched.unique && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-normal text-brand-pink">
                    <Sparkles size={10} /> auto
                  </span>
                )}
              </Label>
              <input
                type="number"
                min={0}
                value={form.leads_unique ?? ''}
                onChange={e => {
                  setTouched(t => ({ ...t, unique: true }));
                  setAutofilled(a => ({ ...a, unique: false }));
                  setForm({ ...form, leads_unique: e.target.value === '' ? null : Number(e.target.value) });
                }}
                className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm tabular-nums"
                placeholder="487"
              />
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <Label>Notes (optional)</Label>
          <textarea
            value={form.notes || ''}
            onChange={e => setForm({ ...form, notes: e.target.value || null })}
            rows={3}
            placeholder="Context, segment, source UTM, prompt version, anything you'd want a teammate to know in 3 weeks…"
            className="w-full px-3 py-2 rounded-lg border border-surface-300 text-sm"
          />
        </div>

        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 justify-end pt-1">
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <button onClick={submit} className="btn bg-brand-pink text-white hover:bg-[#d92853]">
            {isEdit ? 'Save changes' : 'Create entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-surface-700 mb-1">{children}</div>;
}
