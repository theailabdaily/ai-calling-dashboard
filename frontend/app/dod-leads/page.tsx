'use client';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  CalendarDays, Download, Loader2,
} from 'lucide-react';
import { api, fmt } from '@/lib/api';
import type { DodLeadCampaign, Filters } from '@/types';

// Sales-action bucket → matching funnel_stage URL param + display name.
// Single source of truth: changing this updates BOTH the column header AND
// the deep-link query string, so they can never drift apart.
type BucketKey = 'top_priority' | 'interested_only' | 'callback_only' | 'no_intent';
type Bucket = {
  key: BucketKey;
  label: string;
  hint: string;
  accent?: boolean;
};

const BUCKETS: Bucket[] = [
  { key: 'top_priority',    label: 'Top Priority',     hint: 'Interested + Callback', accent: true },
  { key: 'interested_only', label: 'Interested only',  hint: 'HIGH/MEDIUM, no callback ask' },
  { key: 'callback_only',   label: 'Callback only',    hint: 'Asked callback, low/unclear interest' },
  { key: 'no_intent',       label: 'No intent',        hint: 'Connected but no positive signal' },
];

// Date range presets. `days: null` means "no lower bound" (all time).
type RangeKey = 'last_7' | 'last_30' | 'last_90' | 'all_time';
const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: 'last_7',   label: 'Last 7 days',   days: 7   },
  { key: 'last_30',  label: 'Last 30 days',  days: 30  },
  { key: 'last_90',  label: 'Last 90 days',  days: 90  },
  { key: 'all_time', label: 'All time',      days: null },
];

type ViewMode = 'date' | 'campaign';

const PAGE_SIZES = [10, 25, 50, 100];

// Selection key format: "<rowId>|<bucket>" where rowId is an ISO date in
// date view or a campaign_id in campaign view. Single primitive-keyed Set
// keeps add/has/delete cheap.
const cellKey = (rowId: string, bucket: BucketKey) => `${rowId}|${bucket}`;

// ---- CSV row helpers (used by export merge) ----
// Tiny RFC 4180-aware parsers. We only need to split the header into column
// names and to extract a single cell by index from a data row — full row
// parsing isn't needed because we're concatenating rows verbatim into the
// merged file, not transforming them.

function parseCsvHeader(line: string): string[] {
  // Header is almost always unquoted simple names (mobile_number, etc.).
  // Still handle quotes defensively in case the schema adds a name with a
  // comma or quote in it later.
  const cols: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === '"') { inQ = true; continue; }
      if (ch === ',') { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// Extract just the Nth cell from a CSV line. Cheaper than full parsing
// because we early-return once we hit column `idx`. Quote-aware so a
// comma inside a quoted field (the result_json column has these) doesn't
// shift indices.
function extractCsvCell(line: string, idx: number): string {
  let cur = '';
  let inQ = false;
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === '"') { inQ = true; continue; }
      if (ch === ',') {
        if (col === idx) return cur;
        col++;
        cur = '';
        continue;
      }
      cur += ch;
    }
  }
  return col === idx ? cur : '';
}

// Format an IST ISO date ("2026-05-05") for display.
function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

// Today in IST. Render/Vercel servers run UTC so doing the shift
// arithmetically is more predictable than relying on Intl.
function todayIST(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

function isoMinusDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// /calls deep-links — full day, single campaign, full range.
function dayLink(isoDate: string, funnel_stage: string): string {
  const dayStart = new Date(`${isoDate}T00:00:00+05:30`);
  const dayEnd   = new Date(`${isoDate}T23:59:59+05:30`);
  const q = new URLSearchParams({
    start: dayStart.toISOString(),
    end:   dayEnd.toISOString(),
    funnel_stage,
  });
  return `/calls?${q.toString()}`;
}
function campaignLink(campaignId: string, funnel_stage: string): string {
  const q = new URLSearchParams({ funnel_stage });
  q.append('campaign_ids', campaignId);
  return `/calls?${q.toString()}`;
}
function rangeLink(startIso: string, endIso: string, funnel_stage: string): string {
  const start = new Date(`${startIso}T00:00:00+05:30`).toISOString();
  const end   = new Date(`${endIso}T23:59:59+05:30`).toISOString();
  const q = new URLSearchParams({ start, end, funnel_stage });
  return `/calls?${q.toString()}`;
}

export default function DodLeadsPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [range, setRange]       = useState<RangeKey>('last_30');
  const [view, setView]         = useState<ViewMode>('date');
  const [page, setPage]         = useState(0);
  const [pageSize, setPageSize] = useState<number>(10);
  // Cell-level selection. Each entry is `${rowId}|${bucket}`. Row "select
  // all" is checked when ALL 4 buckets for that row are in the set; same
  // for column "select all" across all visible rows.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Export state. Tracks whether a download is currently being assembled and
  // how far along (n of N jobs fetched) so the user gets feedback during the
  // few seconds it takes to fetch many cells. Replaces the prior approach of
  // triggering N separate <a download> clicks — browsers block sequential
  // automated downloads aggressively (Chrome shows a "multiple downloads"
  // prompt that's easy to miss; if dismissed all but the first are dropped).
  const [exportState, setExportState] = useState<
    | { kind: 'idle' }
    | { kind: 'running'; done: number; total: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const dod = useQuery({ queryKey: ['dod-leads'], queryFn: () => api.dodLeads() });
  const allDays = dod.data?.days ?? [];

  // Client-side date-range filter — keeps the picker instant.
  const filteredDays = useMemo(() => {
    const cfg = RANGES.find(r => r.key === range);
    if (!cfg || cfg.days === null) return allDays;
    const cutoff = isoMinusDays(todayIST(), cfg.days);
    return allDays.filter(d => d.date >= cutoff);
  }, [allDays, range]);

  // Earliest / latest actual date in the filtered set — for export and
  // for the totals-row click-throughs.
  const dateBounds = useMemo(() => {
    if (filteredDays.length === 0) {
      const t = todayIST();
      return { start: t, end: t };
    }
    const sorted = filteredDays.map(d => d.date).sort();
    return { start: sorted[0], end: sorted[sorted.length - 1] };
  }, [filteredDays]);

  // Flatten (day, campaign) pairs into a campaign-keyed map, summing counts
  // and tracking which days each campaign was active. Sorted by recency.
  type CampaignRow = DodLeadCampaign & { dates: string[] };
  const campaignRows: CampaignRow[] = useMemo(() => {
    if (view !== 'campaign') return [];
    const map = new Map<string, CampaignRow>();
    for (const day of filteredDays) {
      for (const c of day.campaigns ?? []) {
        const cur = map.get(c.campaign_id);
        if (cur) {
          cur.total_leads     += c.total_leads;
          cur.top_priority    += c.top_priority;
          cur.interested_only += c.interested_only;
          cur.callback_only   += c.callback_only;
          cur.no_intent       += c.no_intent;
          cur.unreached       += c.unreached;
          cur.dates.push(day.date);
        } else {
          map.set(c.campaign_id, { ...c, dates: [day.date] });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const aLatest = a.dates.slice().sort().pop() ?? '';
      const bLatest = b.dates.slice().sort().pop() ?? '';
      return bLatest.localeCompare(aLatest);
    });
  }, [view, filteredDays]);

  // Active row set (date view = days, campaign view = aggregated campaigns).
  // Used for pagination math AND for totals + selection across the whole
  // filtered range (not just visible page).
  const allRows: any[] = view === 'date' ? filteredDays : campaignRows;
  const totalRows = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const startIdx = page * pageSize;
  const endIdx   = Math.min(startIdx + pageSize, totalRows);
  const pageDays      = view === 'date'     ? filteredDays.slice(startIdx, endIdx) : [];
  const pageCampaigns = view === 'campaign' ? campaignRows.slice(startIdx, endIdx) : [];

  // Totals span the ENTIRE filtered range. The column-level checkbox
  // toggles every row across the full range, same as Excel "select all
  // in column" — not just the visible page.
  const totals = useMemo(() => {
    return allRows.reduce(
      (acc, r) => ({
        total_leads:     acc.total_leads     + r.total_leads,
        top_priority:    acc.top_priority    + r.top_priority,
        interested_only: acc.interested_only + r.interested_only,
        callback_only:   acc.callback_only   + r.callback_only,
        no_intent:       acc.no_intent       + r.no_intent,
      }),
      { total_leads: 0, top_priority: 0, interested_only: 0, callback_only: 0, no_intent: 0 },
    );
  }, [allRows]);

  // rowId for the active view mode (date string or campaign_id).
  const rowId = (r: any) => (view === 'date' ? r.date : r.campaign_id) as string;

  // ---- Selection derived state ----
  const isCellSelected = (id: string, b: BucketKey) => selected.has(cellKey(id, b));
  const isRowFullySelected = (id: string) => BUCKETS.every(b => selected.has(cellKey(id, b.key)));
  const isRowPartiallySelected = (id: string) =>
    !isRowFullySelected(id) && BUCKETS.some(b => selected.has(cellKey(id, b.key)));
  const isColumnFullySelected = (b: BucketKey) =>
    allRows.length > 0 && allRows.every(r => selected.has(cellKey(rowId(r), b)));
  const isColumnPartiallySelected = (b: BucketKey) =>
    !isColumnFullySelected(b) && allRows.some(r => selected.has(cellKey(rowId(r), b)));

  // Sum of leads across all ticked cells — drives Export button label.
  const selectedCount = useMemo(() => {
    if (selected.size === 0) return 0;
    let n = 0;
    for (const r of allRows) {
      const id = rowId(r);
      for (const b of BUCKETS) {
        if (selected.has(cellKey(id, b.key))) n += (r as any)[b.key] as number;
      }
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, allRows, view]);

  // ---- Selection actions ----
  const toggleCell = (id: string, b: BucketKey) => {
    setSelected(prev => {
      const next = new Set(prev);
      const k = cellKey(id, b);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const toggleRow = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      const allOn = BUCKETS.every(b => next.has(cellKey(id, b.key)));
      for (const b of BUCKETS) {
        const k = cellKey(id, b.key);
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };
  const toggleColumn = (b: BucketKey) => {
    setSelected(prev => {
      const next = new Set(prev);
      const allOn = allRows.every(r => next.has(cellKey(rowId(r), b)));
      for (const r of allRows) {
        const k = cellKey(rowId(r), b);
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // ---- Export ----
  // For each ticked cell, fetch the matching /calls.csv slice from the
  // backend in parallel, merge them client-side (header once, rows dedup'd
  // by mobile_number), and trigger ONE download.
  //
  // Why this design: the previous version did N separate <a download> clicks
  // staggered 350ms. Browsers (especially Chrome) block sequential automated
  // downloads — only the first succeeded, the rest were silently dropped
  // unless the user accepted a "this site wants to download multiple files"
  // permission prompt. A merged CSV is also what BDs actually want anyway
  // (one master sheet to VLOOKUP against).
  //
  // Whole-column ticks consolidate to a single range-wide download (date
  // view) or one per campaign (campaign view) — anything narrower becomes
  // per-cell jobs. The result is deduplicated by mobile_number since the
  // same lead can appear under multiple ticked cells (e.g. when both a row
  // and a column passing through that row are selected).
  const handleExport = async () => {
    if (selected.size === 0 || exportState.kind === 'running') return;

    type ExportJob = { filters: Filters; bucket: BucketKey; label: string };
    const jobs: ExportJob[] = [];
    const rangeStart = new Date(`${dateBounds.start}T00:00:00+05:30`);
    const rangeEnd   = new Date(`${dateBounds.end}T23:59:59+05:30`);

    for (const b of BUCKETS) {
      if (isColumnFullySelected(b.key)) {
        if (view === 'date') {
          jobs.push({
            filters: { start: rangeStart, end: rangeEnd, vendor_ids: [], campaign_ids: [] },
            bucket: b.key,
            label: `range_${dateBounds.start}_to_${dateBounds.end}`,
          });
        } else {
          for (const r of campaignRows) {
            jobs.push({
              filters: { start: rangeStart, end: rangeEnd, vendor_ids: [], campaign_ids: [r.campaign_id] },
              bucket: b.key,
              label: `campaign_${r.campaign_id.slice(0, 8)}`,
            });
          }
        }
        continue;
      }
      for (const r of allRows) {
        const id = rowId(r);
        if (!selected.has(cellKey(id, b.key))) continue;
        if (view === 'date') {
          jobs.push({
            filters: {
              start: new Date(`${r.date}T00:00:00+05:30`),
              end:   new Date(`${r.date}T23:59:59+05:30`),
              vendor_ids: [],
              campaign_ids: [],
            },
            bucket: b.key,
            label: `day_${r.date}`,
          });
        } else {
          jobs.push({
            filters: { start: rangeStart, end: rangeEnd, vendor_ids: [], campaign_ids: [r.campaign_id] },
            bucket: b.key,
            label: `campaign_${r.campaign_id.slice(0, 8)}`,
          });
        }
      }
    }

    if (jobs.length === 0) return;

    setExportState({ kind: 'running', done: 0, total: jobs.length });
    let completed = 0;

    try {
      // Fetch all jobs in parallel. Each one returns the CSV text from
      // /api/export/calls.csv with the right filters. We tick the progress
      // counter as each promise resolves so the UI feels alive.
      const results = await Promise.all(jobs.map(async (job) => {
        const url = api.exportCallsUrl(job.filters, { funnel_stage: job.bucket });
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) {
          throw new Error(`Job for ${job.bucket}/${job.label} failed: HTTP ${resp.status}`);
        }
        const text = await resp.text();
        completed += 1;
        setExportState({ kind: 'running', done: completed, total: jobs.length });
        return { job, text };
      }));

      // Merge. The backend already returns one row per mobile_number per
      // bucket, but the same phone can appear under multiple ticked cells
      // (e.g. row select + column select intersecting). Dedup by phone keeps
      // the first occurrence we see; this also means the user gets a clean
      // master sheet without manual VLOOKUP cleanup.
      let header: string | null = null;
      const seen = new Set<string>();
      const mergedRows: string[] = [];
      let phoneColIdx = -1;
      let bucketColIdx = -1;

      for (const { job, text } of results) {
        // Normalize line endings before splitting. The backend writes
        // \r\n (RFC 4180) but we don't want blank rows from a trailing newline.
        const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
        if (lines.length === 0) continue;

        if (header === null) {
          header = lines[0];
          // Find mobile_number + bucket col positions. Bucket column
          // doesn't exist in the source CSV — we add it as a new column
          // so the user can see which bucket each row came from in the
          // merged sheet.
          const cols = parseCsvHeader(header);
          phoneColIdx = cols.indexOf('mobile_number');
          if (phoneColIdx < 0) {
            // Fallback — header looks unexpected; bail with a clear error
            throw new Error('Export CSV is missing mobile_number column — unexpected schema');
          }
          bucketColIdx = cols.length; // appended at end
          header = `${header},source_bucket`;
        }
        // Else: skip the duplicate header from this CSV — we already have it.

        for (let i = 1; i < lines.length; i++) {
          const phone = extractCsvCell(lines[i], phoneColIdx);
          if (phone && seen.has(phone)) continue;
          if (phone) seen.add(phone);
          // Append the bucket label to the row so the user can see the
          // origin of each lead in the merged sheet.
          mergedRows.push(`${lines[i]},${job.bucket}`);
        }
      }

      if (!header || mergedRows.length === 0) {
        throw new Error('Export returned no rows. Try a wider date range or different cells.');
      }

      const blob = new Blob([header + '\n' + mergedRows.join('\n')], { type: 'text/csv;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      // Filename encodes scope + lead count + timestamp so multiple exports
      // in a session don't collide on disk.
      const ts = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
      a.download = `leads_${mergedRows.length}_${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a moment — too soon and Safari aborts the download.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

      setExportState({ kind: 'idle' });
    } catch (e: any) {
      setExportState({ kind: 'error', message: e?.message || 'Export failed' });
      // Auto-clear after a few seconds so the button becomes usable again
      setTimeout(() => setExportState({ kind: 'idle' }), 5000);
    }
  };

  // ---- View / range / page-size changes reset paging + selection ----
  // Selection is reset on view/range change because the cell keys change
  // shape (date strings vs campaign_ids), or the set of available rows
  // changes — keeping stale keys around would silently leak into Export.
  const onRangeChange = (k: RangeKey) => {
    setRange(k);
    setPage(0);
    setExpanded(null);
    setSelected(new Set());
  };
  const onViewChange = (v: ViewMode) => {
    setView(v);
    setPage(0);
    setExpanded(null);
    setSelected(new Set());
  };
  const onPageSizeChange = (n: number) => {
    setPageSize(n);
    setPage(0);
  };

  const toggleExpand = (id: string) => setExpanded(prev => (prev === id ? null : id));

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold text-brand-navy flex items-center gap-2">
          <CalendarDays size={22} className="text-brand-pink" />
          Leads
        </h1>
        <p className="text-xs md:text-sm text-surface-500 mt-1">
          Leads grouped by final-status date (the day the most recent call
          for each lead completed). Tick any cell, row, or column to include
          it in the CSV export.
        </p>
      </header>

      {/* ---- Toolbar -------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex bg-surface-100 border border-surface-200 rounded-md p-0.5">
          <button
            type="button"
            onClick={() => onViewChange('date')}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              view === 'date'
                ? 'bg-white text-brand-navy font-medium shadow-sm'
                : 'text-surface-500 hover:text-brand-navy'
            }`}
          >
            By date
          </button>
          <button
            type="button"
            onClick={() => onViewChange('campaign')}
            className={`text-xs px-3 py-1.5 rounded transition-colors ${
              view === 'campaign'
                ? 'bg-white text-brand-navy font-medium shadow-sm'
                : 'text-surface-500 hover:text-brand-navy'
            }`}
          >
            By campaign
          </button>
        </div>

        <select
          value={range}
          onChange={e => onRangeChange(e.target.value as RangeKey)}
          className="text-xs border border-surface-200 rounded-md px-2.5 py-1.5 bg-white text-brand-navy hover:border-surface-300 focus:outline-none focus:ring-2 focus:ring-brand-pink/30"
        >
          {RANGES.map(r => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>

        {filteredDays.length > 0 && (
          <span className="text-[11px] text-surface-500 whitespace-nowrap">
            {formatDate(dateBounds.start)} → {formatDate(dateBounds.end)}
          </span>
        )}

        <div className="flex-1" />

        {selected.size > 0 && (
          <button
            type="button"
            onClick={clearSelection}
            className="text-[11px] text-surface-500 hover:text-brand-navy underline underline-offset-2"
          >
            Clear selection
          </button>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={selected.size === 0 || filteredDays.length === 0 || exportState.kind === 'running'}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-surface-300 bg-white text-brand-navy font-medium hover:border-brand-pink hover:text-brand-pink transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-surface-300 disabled:hover:text-brand-navy"
          title={
            selected.size === 0
              ? 'Tick at least one cell, row, or column'
              : exportState.kind === 'error'
                ? exportState.message
                : `Download a single merged CSV containing ${fmt.int(selectedCount)} leads (deduped by phone)`
          }
        >
          {exportState.kind === 'running' ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Fetching… {exportState.done}/{exportState.total}
            </>
          ) : exportState.kind === 'error' ? (
            <>
              <Download size={13} className="text-red-500" />
              <span className="text-red-600">Failed — retry</span>
            </>
          ) : (
            <>
              <Download size={13} />
              Export CSV
              {selectedCount > 0 && (
                <span className="ml-1 text-[10px] text-surface-500 font-normal">
                  ({fmt.int(selectedCount)})
                </span>
              )}
            </>
          )}
        </button>
      </div>

      {/* ---- Table ---------------------------------------------------- */}
      <div className="card overflow-hidden">
        {dod.isLoading && (
          <div className="p-8 text-center text-sm text-surface-500">Loading…</div>
        )}
        {dod.isError && (
          <div className="p-8 text-center text-sm text-red-600">
            Failed to load leads data. Try refreshing.
          </div>
        )}
        {!dod.isLoading && !dod.isError && totalRows === 0 && (
          <div className="p-8 text-center text-sm text-surface-500">
            {allDays.length === 0
              ? 'No leads in the database yet.'
              : 'No leads in the selected date range. Try widening it.'}
          </div>
        )}

        {totalRows > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-50 border-b border-surface-200 text-[11px] uppercase tracking-wider text-surface-600">
                <tr>
                  <th className="text-left py-2.5 px-3 w-8"></th>
                  <th className="text-left py-2.5 px-3">
                    {view === 'date' ? 'Date' : 'Campaign'}
                  </th>
                  <th className="text-right py-2.5 px-3">Total leads</th>
                  {BUCKETS.map(b => (
                    <th key={b.key} className="text-right py-2.5 px-3 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <TriCheckbox
                          checked={isColumnFullySelected(b.key)}
                          indeterminate={isColumnPartiallySelected(b.key)}
                          onChange={() => toggleColumn(b.key)}
                          accent={!!b.accent}
                          title={`Select all ${b.label} cells`}
                        />
                        <span className="font-medium">{b.label}</span>
                      </div>
                      <div className="text-[10px] text-surface-400 normal-case font-normal mt-0.5 text-right">
                        {b.hint}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* --- By-date view rows --- */}
                {view === 'date' && pageDays.map(day => {
                  const isOpen = expanded === day.date;
                  const camps = day.campaigns ?? [];
                  const expandable = camps.length > 0;
                  const id = day.date;

                  return (
                    <Fragment key={day.date}>
                      <tr className={`border-b border-surface-100 transition-colors hover:bg-surface-50 ${
                        isOpen ? 'bg-surface-50/70' : ''
                      }`}>
                        <td
                          className={`py-3 px-3 text-surface-400 ${expandable ? 'cursor-pointer' : ''}`}
                          onClick={() => expandable && toggleExpand(day.date)}
                        >
                          {expandable && (isOpen
                            ? <ChevronDown size={16} />
                            : <ChevronRight size={16} />)}
                        </td>
                        <td className="py-3 px-3 font-medium text-brand-navy whitespace-nowrap">
                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <TriCheckbox
                              checked={isRowFullySelected(id)}
                              indeterminate={isRowPartiallySelected(id)}
                              onChange={() => toggleRow(id)}
                              title={`Select all buckets for ${formatDate(day.date)}`}
                            />
                            <span>{formatDate(day.date)}</span>
                          </label>
                          {camps.length > 1 && (
                            <span className="ml-2 text-[10px] text-surface-500">
                              {camps.length} campaigns
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right tabular-nums font-medium text-brand-navy">
                          {fmt.int(day.total_leads)}
                        </td>
                        {BUCKETS.map(b => (
                          <td key={b.key} className="py-3 px-3 text-right tabular-nums">
                            <CellWithCheckbox
                              selected={isCellSelected(id, b.key)}
                              onToggle={() => toggleCell(id, b.key)}
                              count={(day as any)[b.key] as number}
                              total={day.total_leads}
                              href={dayLink(day.date, b.key)}
                              accent={!!b.accent}
                              bold
                            />
                          </td>
                        ))}
                      </tr>

                      {isOpen && camps.map(c => (
                        <tr
                          key={`${day.date}-${c.campaign_id}`}
                          className="border-b border-surface-100 bg-surface-50/40 text-[13px]"
                        >
                          <td></td>
                          <td className="py-2.5 px-3 pl-8 text-surface-600 truncate max-w-xs">
                            <span className="text-surface-400 mr-2">↳</span>
                            <span title={c.campaign_name}>{c.campaign_name}</span>
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums text-surface-700">
                            {fmt.int(c.total_leads)}
                          </td>
                          {BUCKETS.map(b => (
                            <td key={b.key} className="py-2.5 px-3 text-right tabular-nums">
                              <CellLink
                                href={campaignLink(c.campaign_id, b.key)}
                                count={(c as any)[b.key] as number}
                                total={c.total_leads}
                                accent={!!b.accent}
                                bold={false}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}

                {/* --- By-campaign view rows --- */}
                {view === 'campaign' && pageCampaigns.map(c => {
                  const sortedDates = c.dates.slice().sort();
                  const earliest = sortedDates[0];
                  const latest   = sortedDates[sortedDates.length - 1];
                  const id = c.campaign_id;
                  return (
                    <tr
                      key={c.campaign_id}
                      className="border-b border-surface-100 hover:bg-surface-50 transition-colors"
                    >
                      <td className="py-3 px-3 text-surface-400"></td>
                      <td className="py-3 px-3 font-medium text-brand-navy">
                        <label className="inline-flex items-start gap-2 cursor-pointer">
                          <TriCheckbox
                            checked={isRowFullySelected(id)}
                            indeterminate={isRowPartiallySelected(id)}
                            onChange={() => toggleRow(id)}
                            title={`Select all buckets for ${c.campaign_name}`}
                          />
                          <div>
                            <div className="truncate max-w-xs" title={c.campaign_name}>
                              {c.campaign_name}
                            </div>
                            <div className="text-[10px] text-surface-500 font-normal mt-0.5">
                              {sortedDates.length === 1
                                ? formatDate(earliest)
                                : `${formatDate(earliest)} → ${formatDate(latest)} · ${sortedDates.length} days`}
                            </div>
                          </div>
                        </label>
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums font-medium text-brand-navy">
                        {fmt.int(c.total_leads)}
                      </td>
                      {BUCKETS.map(b => (
                        <td key={b.key} className="py-3 px-3 text-right tabular-nums">
                          <CellWithCheckbox
                            selected={isCellSelected(id, b.key)}
                            onToggle={() => toggleCell(id, b.key)}
                            count={(c as any)[b.key] as number}
                            total={c.total_leads}
                            href={campaignLink(c.campaign_id, b.key)}
                            accent={!!b.accent}
                            bold
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {/* --- All-dates total row --- */}
                <tr className="border-t-2 border-surface-300 bg-surface-50/80 font-semibold">
                  <td></td>
                  <td className="py-3 px-3 text-brand-navy uppercase text-[11px] tracking-wider">
                    All {view === 'date' ? 'dates' : 'campaigns'} total
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums text-brand-navy">
                    {fmt.int(totals.total_leads)}
                  </td>
                  {BUCKETS.map(b => {
                    const count = (totals as any)[b.key] as number;
                    return (
                      <td key={b.key} className="py-3 px-3 text-right tabular-nums">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <TriCheckbox
                            checked={isColumnFullySelected(b.key)}
                            indeterminate={isColumnPartiallySelected(b.key)}
                            onChange={() => toggleColumn(b.key)}
                            accent={!!b.accent}
                            title={`Select all ${b.label} cells`}
                          />
                          {count === 0 ? (
                            <span className="text-surface-300">0</span>
                          ) : (
                            <Link
                              href={rangeLink(dateBounds.start, dateBounds.end, b.key)}
                              className={`hover:underline ${
                                b.accent ? 'text-emerald-700' : 'text-brand-navy'
                              }`}
                              title="Open this bucket in Call Logs"
                            >
                              {fmt.int(count)}
                            </Link>
                          )}
                        </label>
                      </td>
                    );
                  })}
                </tr>
                <tr className="bg-surface-50/80">
                  <td></td>
                  <td colSpan={6} className="px-3 pb-2.5 pt-0 text-[11px] text-surface-500 italic">
                    {selected.size === 0
                      ? 'Tick any cell, row, or column — Export CSV downloads one merged file'
                      : (
                        <>
                          <span className="font-medium not-italic text-surface-700">
                            {fmt.int(selectedCount)} leads selected
                          </span>
                          <span className="text-surface-400">
                            {' '}({selected.size} {selected.size === 1 ? 'cell' : 'cells'} → 1 merged CSV, deduped by phone)
                          </span>
                        </>
                      )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Pagination ---------------------------------------------- */}
      {totalRows > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-4">
            <span className="text-surface-500">
              Showing {fmt.int(startIdx + 1)}–{fmt.int(endIdx)} of {fmt.int(totalRows)}
              {' '}{view === 'date' ? 'days' : 'campaigns'}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-surface-500">Rows</span>
              <select
                value={pageSize}
                onChange={e => onPageSizeChange(Number(e.target.value))}
                className="border border-surface-200 rounded-md px-1.5 py-0.5 bg-white text-brand-navy"
              >
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(0)}
              disabled={page === 0}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="First page"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-surface-700 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              onClick={() => setPage(totalPages - 1)}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-surface-100 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Last page"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>
      )}

      <div className="card p-4 text-[11px] text-surface-500 leading-relaxed">
        <strong className="text-surface-700">How this is computed:</strong> Date is the
        calendar day (IST) of each lead's most recent call activity — for completed calls
        this is when the call ended; for still-pending leads it's the upload date.
        Each lead is one unique phone number, classified into exactly one bucket among Top
        Priority / Interested only / Callback only / No intent (mutually exclusive among
        connected leads). Unreached leads (still being retried, voicemail, hard fail) are
        NOT in these four columns — see Total leads to gauge what's still pending. Numbers
        click-through to Call Logs with matching filters pre-applied. Export CSV downloads
        ONE merged file containing every lead from every ticked cell, deduplicated by
        mobile_number. A <code>source_bucket</code> column is appended so you can see
        which bucket each lead came from. Drop straight into your master sheet via
        VLOOKUP on mobile_number — no manual file-merging needed.
      </div>
    </div>
  );
}

// ---- Cell components ----------------------------------------------------

// Tri-state checkbox: checked, unchecked, indeterminate (partial). Used
// for row/column "select all" controls so the user can see at a glance
// when a row/column is fully vs partially selected.
function TriCheckbox({
  checked, indeterminate, onChange, accent, title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  accent?: boolean;
  title?: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={el => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={onChange}
      onClick={e => e.stopPropagation()}
      title={title}
      className={`h-3.5 w-3.5 rounded border-surface-300 cursor-pointer ${
        accent ? 'accent-emerald-600' : 'accent-brand-pink'
      }`}
    />
  );
}

// Cell with inline checkbox + click-through link. The checkbox toggles
// inclusion in Export CSV; clicking the number opens /calls filtered to
// that cell. Two separate UX affordances in one cell.
function CellWithCheckbox({
  selected, onToggle, count, total, href, accent, bold,
}: {
  selected: boolean;
  onToggle: () => void;
  count: number;
  total: number;
  href: string;
  accent: boolean;
  bold: boolean;
}) {
  if (count === 0) {
    return (
      <label className="inline-flex items-center gap-2 opacity-60 cursor-not-allowed">
        <TriCheckbox checked={false} onChange={() => {}} accent={accent} />
        <span className="text-surface-300">0</span>
      </label>
    );
  }
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <TriCheckbox checked={selected} onChange={onToggle} accent={accent} />
      <Link
        href={href}
        onClick={e => e.stopPropagation()}
        className={`inline-flex items-baseline gap-1.5 px-2 py-0.5 rounded transition-colors ${
          accent
            ? 'text-emerald-700 hover:bg-emerald-50'
            : 'text-brand-navy hover:bg-surface-100'
        } ${bold ? 'font-semibold' : ''}`}
        title={`Open Call Logs filtered to these ${fmt.int(count)} leads`}
      >
        <span>{fmt.int(count)}</span>
        <span className="text-[10px] text-surface-400 font-normal">
          {pct.toFixed(0)}%
        </span>
      </Link>
    </label>
  );
}

// Plain cell link (no checkbox) — used for the campaign-row expansion
// under each day. Those rows are sub-rows of an already-selectable parent
// row, so they don't need their own checkboxes.
function CellLink({
  href, count, total, accent, bold,
}: { href: string; count: number; total: number; accent: boolean; bold: boolean }) {
  if (count === 0) {
    return <span className="text-surface-300">0</span>;
  }
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <Link
      href={href}
      className={`inline-flex items-baseline gap-1.5 px-2 py-0.5 rounded transition-colors ${
        accent
          ? 'text-emerald-700 hover:bg-emerald-50'
          : 'text-brand-navy hover:bg-surface-100'
      } ${bold ? 'font-semibold' : ''}`}
      title={`Open Call Logs filtered to these ${fmt.int(count)} leads`}
    >
      <span>{fmt.int(count)}</span>
      <span className="text-[10px] text-surface-400 font-normal">
        {pct.toFixed(0)}%
      </span>
    </Link>
  );
}
